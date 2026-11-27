const std = @import("std");
const ThreadedIo = @import("mobile_threaded");
const api = @import("engine_api");
const backend = @import("phone_backend");
const tf = @import("tensorfold");
pub const std_options_debug_io: std.Io = ThreadedIo.global_single_threaded.io();
const HfText = @import("hf_text").HfText;

const Allocator = std.mem.Allocator;
const gpa = std.heap.c_allocator;
const max_prompt_bytes = 256 << 10;
const max_output_tokens = 1024;
const max_image_side: u32 = 4096;

const EventKind = enum(c_int) { tokens = 1, finished = 2 };
const FinishReason = enum(c_int) { stop = 0, length = 1, cancelled = 2, failed = 3 };
const Callback = *const fn (
    context: ?*anyopaque,
    request_id: u64,
    kind: EventKind,
    token_ids: [*]const u32,
    token_count: usize,
    text: ?[*]const u8,
    text_length: usize,
    finish_reason: FinishReason,
    message: ?[*:0]const u8,
) callconv(.c) void;

const RequestState = struct {
    engine: *Engine,
    id: u64,
    callback: Callback,
    callback_context: ?*anyopaque,
    request: api.Request,
    owned_images: []api.Image = &.{},
    owned_pixels: ?[]f32 = null,
    output_ids: std.ArrayList(u32) = .empty,
    emitted_utf8_len: usize = 0,
    decode_failed: bool = false,

    fn destroy(self: *RequestState) void {
        gpa.free(self.request.prompt);
        if (self.owned_pixels) |pixels| gpa.free(pixels);
        if (self.owned_images.len > 0) gpa.free(self.owned_images);
        self.output_ids.deinit(gpa);
        gpa.destroy(self);
    }

    fn emitFailure(self: *RequestState, name: []const u8) void {
        self.decode_failed = true;
        self.engine.opened.engine.cancel(self.id);
        std.log.err("mobile request {d}: {s}", .{ self.id, name });
    }

    /// Incrementally decodes the full emitted sequence so multi-byte UTF-8 tokens
    /// (curly apostrophes, em-dashes, accents) never abort mid-stream.
    fn decodeDelta(self: *RequestState) ?[]u8 {
        const full = self.engine.hf.tok.decode(gpa, self.output_ids.items, true) catch {
            self.emitFailure("could not decode streamed tokens");
            return null;
        };
        defer gpa.free(full);
        if (full.len <= self.emitted_utf8_len) return null;
        // Hold back trailing U+FFFD replacement characters until the next token completes the codepoint.
        const replacement = "\xef\xbf\xbd";
        var safe_end = full.len;
        while (safe_end >= self.emitted_utf8_len + replacement.len and
            std.mem.endsWith(u8, full[0..safe_end], replacement))
        {
            safe_end -= replacement.len;
        }
        if (safe_end <= self.emitted_utf8_len) return null;
        const delta = gpa.dupe(u8, full[self.emitted_utf8_len..safe_end]) catch {
            self.emitFailure("out of memory copying streamed UTF-8 delta");
            return null;
        };
        self.emitted_utf8_len = safe_end;
        return delta;
    }

    fn sink(context: *anyopaque, id: api.Id, event: *const api.Event) void {
        const self: *RequestState = @ptrCast(@alignCast(context));
        switch (event.*) {
            .tokens => |ids| {
                if (self.decode_failed) return;
                self.output_ids.appendSlice(gpa, ids) catch {
                    self.emitFailure("out of memory while retaining output tokens");
                    return;
                };
                const delta = self.decodeDelta();
                defer if (delta) |bytes| gpa.free(bytes);
                self.callback(
                    self.callback_context,
                    id,
                    .tokens,
                    ids.ptr,
                    ids.len,
                    if (delta) |bytes| if (bytes.len > 0) bytes.ptr else null else null,
                    if (delta) |bytes| bytes.len else 0,
                    .stop,
                    null,
                );
            },
            .finished => |done| {
                self.engine.mutex.lockUncancelable(self.engine.owned_io.io());
                _ = self.engine.requests.remove(self.id);
                self.engine.mutex.unlock(self.engine.owned_io.io());
                const reason: FinishReason = if (self.decode_failed) .failed else switch (done.reason) {
                    .stop => .stop,
                    .length => .length,
                    .cancelled => .cancelled,
                    .failed, .silence => .failed,
                };
                const final_text = self.engine.hf.tok.decode(gpa, self.output_ids.items, true) catch null;
                defer if (final_text) |bytes| gpa.free(bytes);
                var message_z: ?[:0]const u8 = null;
                var owns_message = false;
                if (self.decode_failed) {
                    message_z = "stream decoding failed";
                } else if (done.message.len > 0) {
                    message_z = gpa.dupeSentinel(u8, done.message, 0) catch null;
                    owns_message = message_z != null;
                }
                defer if (owns_message) gpa.free(message_z.?);
                self.callback(
                    self.callback_context,
                    id,
                    .finished,
                    self.output_ids.items.ptr,
                    self.output_ids.items.len,
                    if (final_text) |bytes| bytes.ptr else null,
                    if (final_text) |bytes| bytes.len else 0,
                    reason,
                    if (message_z) |text| text.ptr else null,
                );
                self.destroy();
            },
            else => {},
        }
    }
};

const Engine = struct {
    owned_io: ThreadedIo,
    hf: *HfText,
    opened: api.Opened,
    info_json: [:0]u8,
    has_vision: bool = false,
    image_token: u32 = 125030,
    max_image_tokens: u32 = 256,
    mutex: std.Io.Mutex = .init,
    requests: std.AutoHashMapUnmanaged(u64, *RequestState) = .empty,
    closing: bool = false,

    fn close(self: *Engine) void {
        self.mutex.lockUncancelable(self.owned_io.io());
        self.closing = true;
        var it = self.requests.iterator();
        while (it.next()) |entry| self.opened.engine.cancel(entry.key_ptr.*);
        self.mutex.unlock(self.owned_io.io());
        self.opened.close(self.opened.ctx);
        var pending = self.requests.iterator();
        while (pending.next()) |entry| entry.value_ptr.*.destroy();
        self.requests.deinit(gpa);
        self.hf.deinit();
        gpa.free(self.info_json);
        self.owned_io.deinit();
        gpa.destroy(self);
    }
};

fn writeError(out: [*]u8, capacity: usize, message: []const u8) void {
    if (capacity == 0) return;
    const count = @min(message.len, capacity - 1);
    @memcpy(out[0..count], message[0..count]);
    out[count] = 0;
}

fn fail(out: [*]u8, capacity: usize, err: anyerror) i32 {
    writeError(out, capacity, @errorName(err));
    return -1;
}

export fn sonar_tf_capabilities_json() [*:0]const u8 {
    return "{\"schema\":2,\"backend\":\"metal\",\"inference\":true,\"streaming\":true,\"cancellation\":true,\"vision\":true,\"modelType\":\"lfm3_vl\",\"supportedModelTypes\":[\"lfm3_vl\",\"lfm3\",\"qwen3_5\"],\"limitations\":[\"Native TensorFold Metal mobile engine serving LFM3-VL-2B (vision + text), LFM3-1.7B, and Qwen3.5-2B on iOS Metal GPUs.\"]}";
}

export fn sonar_tf_open(
    directory: [*:0]const u8,
    max_context: u32,
    prompt_cache_mib: u32,
    error_out: [*]u8,
    error_capacity: usize,
) ?*Engine {
    if (max_context == 0 or max_context > 32768 or prompt_cache_mib > 256) {
        writeError(error_out, error_capacity, "context must be 1..32768 tokens and prompt cache at most 256 MiB");
        return null;
    }
    const path = std.mem.span(directory);
    if (path.len == 0 or path.len > 4096) {
        writeError(error_out, error_capacity, "invalid checkpoint directory");
        return null;
    }
    const state = gpa.create(Engine) catch {
        writeError(error_out, error_capacity, "out of memory creating engine");
        return null;
    };
    state.owned_io = .init(gpa, .{});
    const io = state.owned_io.io();
    errdefer state.owned_io.deinit();
    var temporary: std.heap.ArenaAllocator = .init(gpa);
    defer temporary.deinit();
    const a = temporary.allocator();
    var problem: []const u8 = "";
    state.hf = HfText.load(gpa, io, path, null, a, &problem) catch |err| {
        if (problem.len > 0) writeError(error_out, error_capacity, problem) else writeError(error_out, error_capacity, @errorName(err));
        state.owned_io.deinit();
        gpa.destroy(state);
        return null;
    };
    const model_config_path = std.fs.path.join(a, &.{ path, "config.json" }) catch {
        state.hf.deinit();
        state.owned_io.deinit();
        gpa.destroy(state);
        writeError(error_out, error_capacity, "out of memory reading config.json");
        return null;
    };
    const config_bytes = std.Io.Dir.cwd().readFileAlloc(io, model_config_path, a, .limited(16 << 20)) catch |err| {
        state.hf.deinit();
        state.owned_io.deinit();
        gpa.destroy(state);
        writeError(error_out, error_capacity, @errorName(err));
        return null;
    };
    const config = std.json.parseFromSliceLeaky(std.json.Value, a, config_bytes, .{}) catch {
        state.hf.deinit();
        state.owned_io.deinit();
        gpa.destroy(state);
        writeError(error_out, error_capacity, "invalid config.json");
        return null;
    };
    const kind_value = if (config == .object) config.object.get("model_type") else null;
    if (kind_value == null or kind_value.? != .string) {
        state.hf.deinit();
        state.owned_io.deinit();
        gpa.destroy(state);
        writeError(error_out, error_capacity, "config.json has no model_type string");
        return null;
    }
    const cache_gib: f64 = if (prompt_cache_mib == 0) 0.0 else @as(f64, @floatFromInt(prompt_cache_mib)) / 1024.0;
    state.opened = backend.open(a, gpa, io, .{
        .dir = path,
        .model_type = kind_value.?.string,
        .context = max_context,
        .lanes = 1,
        .lanes_fixed = true,
        .drafts = false,
        .prompt_cache_gib = cache_gib,
        .prompt_cache_over_cap = prompt_cache_mib > 0,
        .vision = null,
    }, &problem) catch |err| {
        state.hf.deinit();
        state.owned_io.deinit();
        gpa.destroy(state);
        if (problem.len > 0) writeError(error_out, error_capacity, problem) else writeError(error_out, error_capacity, @errorName(err));
        return null;
    } orelse {
        state.hf.deinit();
        state.owned_io.deinit();
        gpa.destroy(state);
        writeError(error_out, error_capacity, if (problem.len > 0) problem else "TensorFold refused the checkpoint");
        return null;
    };
    const info = state.opened.engine.info();
    state.has_vision = info.vision != null;
    if (info.vision) |v| {
        state.image_token = v.image_token;
        state.max_image_tokens = v.image_tokens;
    } else {
        state.image_token = 125030;
        state.max_image_tokens = 256;
    }
    state.info_json = gpa.printSentinel(
        "{{\"backend\":\"{s}\",\"modelType\":\"{s}\",\"contextWindow\":{d},\"textGeneration\":{s},\"vision\":{s},\"maxImageTokens\":{d},\"streamLimit\":1}}",
        .{
            backend.backend,
            kind_value.?.string,
            info.context_window,
            if (info.text_generation) "true" else "false",
            if (state.has_vision) "true" else "false",
            if (state.has_vision) state.max_image_tokens else 0,
        },
        0,
    ) catch {
        state.opened.close(state.opened.ctx);
        state.hf.deinit();
        state.owned_io.deinit();
        gpa.destroy(state);
        writeError(error_out, error_capacity, "out of memory publishing model information");
        return null;
    };
    state.requests = .empty;
    state.mutex = .init;
    state.closing = false;
    return state;
}

export fn sonar_tf_info_json(state: *Engine) [*:0]const u8 {
    return state.info_json.ptr;
}

export fn sonar_tf_close(state: *Engine) void {
    state.close();
}

fn expandImageToken(encoded: []const u32, image_token: u32, count: u32) !struct { tokens: []u32, at: u32 } {
    var pos: ?usize = null;
    for (encoded, 0..) |tok, idx| {
        if (tok == image_token) {
            pos = idx;
            break;
        }
    }
    const at = pos orelse return error.MissingImagePlaceholder;
    if (count == 0) return error.InvalidImageTokenCount;
    const total = encoded.len - 1 + @as(usize, count);
    const expanded = try gpa.alloc(u32, total);
    @memcpy(expanded[0..at], encoded[0..at]);
    @memset(expanded[at .. at + count], image_token);
    @memcpy(expanded[at + count ..], encoded[at + 1 ..]);
    return .{ .tokens = expanded, .at = @intCast(at) };
}

fn submitInternal(
    state: *Engine,
    request_id: u64,
    prompt_ptr: [*]const u8,
    prompt_len: usize,
    rgb_pixels: ?[*]const u8,
    image_width: u32,
    image_height: u32,
    max_image_tokens: u32,
    max_tokens: u32,
    sample: i32,
    temperature: f64,
    top_k: u32,
    top_p: f64,
    min_p: f64,
    seed: u64,
    callback: Callback,
    callback_context: ?*anyopaque,
    error_out: [*]u8,
    error_capacity: usize,
) i32 {
    if (request_id == 0 or max_tokens == 0 or max_tokens > max_output_tokens or prompt_len == 0 or prompt_len > max_prompt_bytes)
        return fail(error_out, error_capacity, error.InvalidRequest);
    if (sample != 0 and (!std.math.isFinite(temperature) or temperature <= 0 or !std.math.isFinite(top_p) or
        top_p <= 0 or top_p > 1 or !std.math.isFinite(min_p) or min_p < 0 or min_p > 1))
        return fail(error_out, error_capacity, error.InvalidSampling);

    const has_image = rgb_pixels != null and image_width > 0 and image_height > 0;
    if (has_image) {
        if (!state.has_vision) {
            writeError(error_out, error_capacity, "loaded TensorFold checkpoint does not have a vision tower");
            return -1;
        }
        if (image_width > max_image_side or image_height > max_image_side) {
            writeError(error_out, error_capacity, "image dimensions exceed 4096x4096 mobile limit");
            return -1;
        }
    }

    // Fast busy/closing check — release mutex before encoding & image preprocessing!
    state.mutex.lockUncancelable(state.owned_io.io());
    const busy = state.closing or state.requests.count() != 0 or state.requests.contains(request_id);
    state.mutex.unlock(state.owned_io.io());
    if (busy) return fail(error_out, error_capacity, error.Busy);

    var ids = state.hf.text().encode(gpa, prompt_ptr[0..prompt_len], false) catch |err| return fail(error_out, error_capacity, err);
    var owned_pixels: ?[]f32 = null;
    var owned_images: []api.Image = &.{};

    if (has_image) {
        const byte_len = std.math.mul(usize, std.math.mul(usize, image_width, image_height) catch {
            gpa.free(ids);
            return fail(error_out, error_capacity, error.InvalidImageSize);
        }, 3) catch {
            gpa.free(ids);
            return fail(error_out, error_capacity, error.InvalidImageSize);
        };
        const raw_slice = rgb_pixels.?[0..byte_len];
        const copy_rgb = gpa.dupe(u8, raw_slice) catch {
            gpa.free(ids);
            return fail(error_out, error_capacity, error.OutOfMemory);
        };
        defer gpa.free(copy_rgb);

        const budget = @min(
            state.max_image_tokens,
            if (max_image_tokens >= tf.lfm3.image.min_budget) max_image_tokens else state.max_image_tokens,
        );
        const rgb: tf.picture.Rgb = .{
            .width = image_width,
            .height = image_height,
            .pixels = copy_rgb,
        };
        const identity = tf.picture.identity.ofBytes(0x1f33, copy_rgb);
        const prepared = tf.lfm3.image.prepareRgb(gpa, rgb, identity, budget) catch |err| {
            gpa.free(ids);
            return fail(error_out, error_capacity, err);
        };
        owned_pixels = prepared.pixels;

        const expanded = expandImageToken(ids, state.image_token, prepared.tokens) catch |err| {
            gpa.free(prepared.pixels);
            gpa.free(ids);
            return fail(error_out, error_capacity, err);
        };
        gpa.free(ids);
        ids = expanded.tokens;

        owned_images = gpa.alloc(api.Image, 1) catch {
            gpa.free(prepared.pixels);
            gpa.free(ids);
            return fail(error_out, error_capacity, error.OutOfMemory);
        };
        owned_images[0] = .{
            .pixels = prepared.pixels,
            .gh = prepared.gh,
            .gw = prepared.gw,
            .at = expanded.at,
            .tokens = prepared.tokens,
            .hash = prepared.hash,
        };
    }

    const context = state.opened.engine.info().context_window;
    if (context > 0 and ids.len + max_tokens > context) {
        gpa.free(ids);
        if (owned_pixels) |p| gpa.free(p);
        if (owned_images.len > 0) gpa.free(owned_images);
        return fail(error_out, error_capacity, error.PromptTooLong);
    }

    const request_state = gpa.create(RequestState) catch {
        gpa.free(ids);
        if (owned_pixels) |p| gpa.free(p);
        if (owned_images.len > 0) gpa.free(owned_images);
        return fail(error_out, error_capacity, error.OutOfMemory);
    };
    request_state.* = .{
        .engine = state,
        .id = request_id,
        .callback = callback,
        .callback_context = callback_context,
        .owned_images = owned_images,
        .owned_pixels = owned_pixels,
        .request = .{
            .prompt = ids,
            .images = owned_images,
            .max_tokens = max_tokens,
            .eos = state.hf.text().eosIds(),
            .sampling = if (sample > 0) .{ .seed = seed, .temperature = temperature, .top_k = top_k, .top_p = top_p, .min_p = min_p } else null,
        },
    };

    state.mutex.lockUncancelable(state.owned_io.io());
    if (state.closing or state.requests.count() != 0 or state.requests.contains(request_id)) {
        const closed = state.closing;
        state.mutex.unlock(state.owned_io.io());
        request_state.destroy();
        return fail(error_out, error_capacity, if (closed) error.Closed else error.Busy);
    }
    state.requests.put(gpa, request_id, request_state) catch {
        state.mutex.unlock(state.owned_io.io());
        request_state.destroy();
        return fail(error_out, error_capacity, error.OutOfMemory);
    };
    state.mutex.unlock(state.owned_io.io());

    state.opened.engine.submit(request_id, &request_state.request, .{ .ctx = request_state, .event = RequestState.sink }) catch |err| {
        state.mutex.lockUncancelable(state.owned_io.io());
        _ = state.requests.remove(request_id);
        state.mutex.unlock(state.owned_io.io());
        request_state.destroy();
        return fail(error_out, error_capacity, err);
    };
    return 0;
}

export fn sonar_tf_generate(
    state: *Engine,
    request_id: u64,
    prompt_ptr: [*]const u8,
    prompt_len: usize,
    max_tokens: u32,
    sample: i32,
    temperature: f64,
    top_k: u32,
    top_p: f64,
    min_p: f64,
    seed: u64,
    callback: Callback,
    callback_context: ?*anyopaque,
    error_out: [*]u8,
    error_capacity: usize,
) i32 {
    return submitInternal(
        state,
        request_id,
        prompt_ptr,
        prompt_len,
        null,
        0,
        0,
        0,
        max_tokens,
        sample,
        temperature,
        top_k,
        top_p,
        min_p,
        seed,
        callback,
        callback_context,
        error_out,
        error_capacity,
    );
}

export fn sonar_tf_generate_vision(
    state: *Engine,
    request_id: u64,
    prompt_ptr: [*]const u8,
    prompt_len: usize,
    rgb_pixels: ?[*]const u8,
    image_width: u32,
    image_height: u32,
    max_image_tokens: u32,
    max_tokens: u32,
    sample: i32,
    temperature: f64,
    top_k: u32,
    top_p: f64,
    min_p: f64,
    seed: u64,
    callback: Callback,
    callback_context: ?*anyopaque,
    error_out: [*]u8,
    error_capacity: usize,
) i32 {
    return submitInternal(
        state,
        request_id,
        prompt_ptr,
        prompt_len,
        rgb_pixels,
        image_width,
        image_height,
        max_image_tokens,
        max_tokens,
        sample,
        temperature,
        top_k,
        top_p,
        min_p,
        seed,
        callback,
        callback_context,
        error_out,
        error_capacity,
    );
}

export fn sonar_tf_cancel(state: *Engine, request_id: u64) void {
    state.mutex.lockUncancelable(state.owned_io.io());
    if (!state.closing and state.requests.contains(request_id)) state.opened.engine.cancel(request_id);
    state.mutex.unlock(state.owned_io.io());
}
