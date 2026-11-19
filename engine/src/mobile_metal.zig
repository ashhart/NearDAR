const std = @import("std");
const ThreadedIo = @import("mobile_threaded");
const api = @import("engine_api");
const backend = @import("phone_backend");
pub const std_options_debug_io: std.Io = ThreadedIo.global_single_threaded.io();
const HfText = @import("hf_text").HfText;

const Allocator = std.mem.Allocator;
const gpa = std.heap.c_allocator;
const max_prompt_bytes = 256 << 10;
const max_output_tokens = 1024;

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
    output_ids: std.ArrayList(u32) = .empty,
    pending_utf8: std.ArrayList(u8) = .empty,
    decode_failed: bool = false,

    fn destroy(self: *RequestState) void {
        gpa.free(self.request.prompt);
        self.output_ids.deinit(gpa);
        self.pending_utf8.deinit(gpa);
        gpa.destroy(self);
    }

    fn emitFailure(self: *RequestState, name: []const u8) void {
        self.decode_failed = true;
        self.engine.opened.engine.cancel(self.id);
        // The terminal event is delivered by TensorFold after cancellation.
        std.log.err("mobile request {d}: {s}", .{ self.id, name });
    }

    fn streamText(self: *RequestState, ids: []const u32) ?[]const u8 {
        self.pending_utf8.clearRetainingCapacity();
        for (ids) |id| {
            if (self.engine.hf.text().isSpecial(id)) continue;
            const bytes = self.engine.hf.text().tokenBytes(gpa, id) catch {
                self.emitFailure("could not read token bytes");
                return null;
            } orelse {
                self.emitFailure("token has no UTF-8 text representation");
                return null;
            };
            defer gpa.free(bytes);
            if (!std.unicode.utf8ValidateSlice(bytes)) {
                self.emitFailure("token is not valid standalone UTF-8");
                return null;
            }
            self.pending_utf8.appendSlice(gpa, bytes) catch {
                self.emitFailure("out of memory while retaining streamed text");
                return null;
            };
        }
        return self.pending_utf8.items;
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
                const text = self.streamText(ids);
                self.callback(
                    self.callback_context,
                    id,
                    .tokens,
                    ids.ptr,
                    ids.len,
                    if (text) |bytes| if (bytes.len > 0) bytes.ptr else null else null,
                    if (text) |bytes| bytes.len else 0,
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
    return "{\"schema\":1,\"backend\":\"metal\",\"inference\":true,\"streaming\":true,\"cancellation\":true,\"vision\":false,\"modelType\":\"qwen3_5\",\"limitations\":[\"Qwen3.5-2B Metal only; other families and 27B layouts are refused\",\"Text prompts only; no image encoder is admitted\",\"Phone inference requires on-device qualification before production release\"]}";
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
    const cache_gib = @as(f64, @floatFromInt(prompt_cache_mib)) / 1024.0;
    state.opened = backend.open(a, gpa, io, .{
        .dir = path,
        .model_type = kind_value.?.string,
        .context = max_context,
        .lanes = 1,
        .lanes_fixed = true,
        .drafts = false,
        .prompt_cache_gib = cache_gib,
        .vision = null,
    }, &problem) catch |err| {
        state.hf.deinit();
        state.owned_io.deinit();
        gpa.destroy(state);
        writeError(error_out, error_capacity, @errorName(err));
        return null;
    } orelse {
        state.hf.deinit();
        state.owned_io.deinit();
        gpa.destroy(state);
        writeError(error_out, error_capacity, if (problem.len > 0) problem else "TensorFold refused the checkpoint");
        return null;
    };
    const info = state.opened.engine.info();
    state.info_json = gpa.printSentinel(
        "{{\"backend\":\"{s}\",\"modelType\":\"{s}\",\"contextWindow\":{d},\"textGeneration\":{s},\"vision\":false,\"streamLimit\":1}}",
        .{ backend.backend, kind_value.?.string, info.context_window, if (info.text_generation) "true" else "false" },
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
    if (request_id == 0 or max_tokens == 0 or max_tokens > max_output_tokens or prompt_len == 0 or prompt_len > max_prompt_bytes)
        return fail(error_out, error_capacity, error.InvalidRequest);
    if (sample != 0 and (!std.math.isFinite(temperature) or temperature <= 0 or !std.math.isFinite(top_p) or
        top_p <= 0 or top_p > 1 or !std.math.isFinite(min_p) or min_p < 0 or min_p > 1))
        return fail(error_out, error_capacity, error.InvalidSampling);
    state.mutex.lockUncancelable(state.owned_io.io());
    if (state.closing or state.requests.count() != 0 or state.requests.contains(request_id)) {
        state.mutex.unlock(state.owned_io.io());
        return fail(error_out, error_capacity, error.Busy);
    }
    const ids = state.hf.text().encode(gpa, prompt_ptr[0..prompt_len], false) catch |err| return fail(error_out, error_capacity, err);
    const context = state.opened.engine.info().context_window;
    if (context > 0 and ids.len + max_tokens > context) {
        gpa.free(ids);
        return fail(error_out, error_capacity, error.PromptTooLong);
    }
    const request_state = gpa.create(RequestState) catch {
        gpa.free(ids);
        return fail(error_out, error_capacity, error.OutOfMemory);
    };
    request_state.* = .{
        .engine = state,
        .id = request_id,
        .callback = callback,
        .callback_context = callback_context,
        .request = .{
            .prompt = ids,
            .max_tokens = max_tokens,
            .eos = state.hf.text().eosIds(),
            .sampling = if (sample > 0) .{ .seed = seed, .temperature = temperature, .top_k = top_k, .top_p = top_p, .min_p = min_p } else null,
        },
    };
    state.mutex.lockUncancelable(state.owned_io.io());
    if (state.closing) {
        state.mutex.unlock(state.owned_io.io());
        request_state.destroy();
        return fail(error_out, error_capacity, error.Closed);
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

export fn sonar_tf_cancel(state: *Engine, request_id: u64) void {
    state.mutex.lockUncancelable(state.owned_io.io());
    if (!state.closing and state.requests.contains(request_id)) state.opened.engine.cancel(request_id);
    state.mutex.unlock(state.owned_io.io());
}
