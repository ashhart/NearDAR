//! Android C ABI: reports that this upstream revision has no served mobile backend.
//! Vulkan in this revision contains QMM kernels, loaders and probes, not a model engine.
const std = @import("std");

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

const refusal = "TensorFold 1.2.10 has no Android model server: its Vulkan target provides QMM contracts and device probes only; no inference was started";

fn writeError(out: [*]u8, capacity: usize, message: []const u8) void {
    if (capacity == 0) return;
    const count = @min(message.len, capacity - 1);
    @memcpy(out[0..count], message[0..count]);
    out[count] = 0;
}

export fn sonar_tf_capabilities_json() [*:0]const u8 {
    return "{\"schema\":1,\"backend\":\"unavailable\",\"inference\":false,\"streaming\":false,\"cancellation\":false,\"vision\":false,\"modelType\":null,\"limitations\":[\"This upstream revision has no Android model engine. Vulkan contains QMM kernels and probes, not checkpoint loading or text generation.\"]}";
}

export fn sonar_tf_open(directory: [*:0]const u8, max_context: u32, prompt_cache_mib: u32, error_out: [*]u8, error_capacity: usize) ?*anyopaque {
    _ = directory;
    _ = max_context;
    _ = prompt_cache_mib;
    writeError(error_out, error_capacity, refusal);
    return null;
}

export fn sonar_tf_info_json(engine: *anyopaque) [*:0]const u8 {
    _ = engine;
    return "{\"backend\":\"unavailable\",\"inference\":false}";
}

export fn sonar_tf_close(engine: *anyopaque) void {
    _ = engine;
    // No engine can exist because open always refuses before allocating one.
}

export fn sonar_tf_generate(
    engine: *anyopaque,
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
    _ = engine;
    _ = request_id;
    _ = prompt_ptr;
    _ = prompt_len;
    _ = max_tokens;
    _ = sample;
    _ = temperature;
    _ = top_k;
    _ = top_p;
    _ = min_p;
    _ = seed;
    _ = callback;
    _ = callback_context;
    writeError(error_out, error_capacity, refusal);
    return -1;
}

export fn sonar_tf_cancel(engine: *anyopaque, request_id: u64) void {
    _ = engine;
    _ = request_id;
    // Cancellation has no request to address while no backend can be opened.
}
