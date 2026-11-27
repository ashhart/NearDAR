//! The phone's admission layer over TensorFold's mobile-sized Metal families:
//! LFM3-VL-2B (vision + language), LFM3-1.7B (text), and Qwen3.5-2B (text).
const std = @import("std");
const api = @import("engine_api");

pub const backend = "metal";
pub const families: []const api.Family = &.{
    .{ .model_type = "lfm3_vl", .formats = &.{
        "mlx-q4g32", "mlx-q4g64", "mlx-q6g64", "mlx-q8g64",
    } },
    .{ .model_type = "lfm3", .formats = &.{
        "mlx-q4g32", "mlx-q4g64", "mlx-q6g64", "mlx-q8g64",
    } },
    .{ .model_type = "qwen3_5", .formats = &.{
        "mlx-q2g32", "mlx-q2g64", "mlx-q2g128",
        "mlx-q3g32", "mlx-q3g64", "mlx-q3g128",
        "mlx-q4g32", "mlx-q4g64", "mlx-q4g128",
        "mlx-q5g32", "mlx-q5g64", "mlx-q5g128",
        "mlx-q6g32", "mlx-q6g64", "mlx-q6g128",
        "mlx-q8g32", "mlx-q8g64", "mlx-q8g128",
    } },
};

/// Admits mobile-sized TensorFold Metal checkpoints: LFM3-VL-2B (with native vision),
/// LFM3-1.7B, and dense Qwen3.5-2B. Desktop 27B/MoE checkpoints are refused.
pub fn open(
    a: std.mem.Allocator,
    gpa: std.mem.Allocator,
    io: std.Io,
    o: api.Open,
    problem: *[]const u8,
) !?api.Opened {
    var phone = o;
    phone.lanes = 1;
    phone.lanes_fixed = true;
    phone.drafts = false;
    phone.drafter = null;

    if (std.mem.eql(u8, o.model_type, "lfm3_vl")) {
        phone.vision = .{
            .image_tokens = 256,
            .image_tokens_set = true,
            .max_images = 1,
        };
        return @import("phone_families").lfm3.open(a, gpa, io, phone, problem);
    }
    if (std.mem.eql(u8, o.model_type, "lfm3")) {
        phone.vision = null;
        return @import("phone_families").lfm3.open(a, gpa, io, phone, problem);
    }
    if (std.mem.eql(u8, o.model_type, "qwen3_5")) {
        if (@import("phone_families").qwen27_engine.owns(a, io, o.dir, false)) {
            problem.* = "Qwen3.8 27B-class checkpoints are not admitted on phones";
            return null;
        }
        phone.vision = null;
        return @import("phone_families").qwen35.open(a, gpa, io, phone, problem);
    }

    problem.* = "this mobile TensorFold build serves LFM3-VL-2B, LFM3-1.7B, or Qwen3.5-2B Metal checkpoints";
    return null;
}
