//! The phone's deliberately narrow admission layer over TensorFold's Qwen3.5 Metal family.
const std = @import("std");
const api = @import("engine_api");

pub const backend = "metal";
pub const families: []const api.Family = &.{
    .{ .model_type = "qwen3_5", .formats = &.{
        "mlx-q2g32", "mlx-q2g64", "mlx-q2g128",
        "mlx-q3g32", "mlx-q3g64", "mlx-q3g128",
        "mlx-q4g32", "mlx-q4g64", "mlx-q4g128",
        "mlx-q5g32", "mlx-q5g64", "mlx-q5g128",
        "mlx-q6g32", "mlx-q6g64", "mlx-q6g128",
        "mlx-q8g32", "mlx-q8g64", "mlx-q8g128",
    } },
};

/// Admits only the dense 2B layout. The same model_type also names 27B and MoE
/// checkpoints, which have no phone memory or device qualification.
pub fn open(
    a: std.mem.Allocator,
    gpa: std.mem.Allocator,
    io: std.Io,
    o: api.Open,
    problem: *[]const u8,
) !?api.Opened {
    if (!std.mem.eql(u8, o.model_type, "qwen3_5")) {
        problem.* = "this phone build serves only TensorFold's Qwen3.5-2B Metal checkpoint";
        return null;
    }
    if (@import("qwen27_engine").owns(a, io, o.dir)) {
        problem.* = "Qwen3.8 27B-class checkpoints are not admitted on phones";
        return null;
    }
    var phone = o;
    phone.lanes = 1;
    phone.lanes_fixed = true;
    phone.drafts = false;
    phone.drafter = null;
    phone.vision = null;
    return @import("qwen35_family").open(a, gpa, io, phone, problem);
}
