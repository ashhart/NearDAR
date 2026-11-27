const std = @import("std");

var upstream: []const u8 = "../vendor/TensorFold";

pub fn build(b: *std.Build) void {
    upstream = b.option([]const u8, "source-root", "TensorFold source root or app-owned mobile overlay") orelse "../vendor/TensorFold";
    const target = b.standardTargetOptions(.{});
    const optimize = b.option(std.builtin.OptimizeMode, "optimize", "debug, safe, fast or small") orelse .safe;
    const shared = b.option(bool, "shared", "Build a shared object instead of a static library") orelse false;
    const os = target.result.os.tag;
    const root = if (os == .ios) b.path("src/mobile_metal.zig") else b.path("src/mobile_unavailable.zig");
    const root_module = b.createModule(.{ .root_source_file = root, .target = target, .optimize = optimize, .link_libc = os == .ios });
    if (os == .ios) wireMetal(b, root_module, target, optimize);
    const library = b.addLibrary(.{ .name = "tensorfold_mobile", .linkage = if (shared) .dynamic else .static, .root_module = root_module });
    b.installArtifact(library);
    b.installFile("include/tensorfold_mobile.h", "include/tensorfold_mobile.h");
}

fn module(b: *std.Build, relative: []const u8, target: std.Build.ResolvedTarget, optimize: std.builtin.OptimizeMode) *std.Build.Module {
    return b.createModule(.{
        .root_source_file = b.path(b.pathJoin(&.{ upstream, relative })),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
}

fn wireMetal(b: *std.Build, root: *std.Build.Module, target: std.Build.ResolvedTarget, optimize: std.builtin.OptimizeMode) void {
    const prepare_io = b.addSystemCommand(&.{ "node" });
    prepare_io.addFileArg(b.path("../scripts/engine/prepare-mobile-io.mjs"));
    const mobile_io = b.createModule(.{ .root_source_file = prepare_io.addOutputFileArg("Threaded.zig"), .target = target, .optimize = optimize, .link_libc = true });
    root.addImport("mobile_threaded", mobile_io);
    const metal = module(b, "zig/src/metal/metal.zig", target, optimize);
    metal.linkFramework("Metal", .{});
    metal.linkFramework("Foundation", .{});
    metal.linkFramework("IOSurface", .{});
    metal.linkSystemLibrary("objc", .{});
    const sdk = b.option([]const u8, "sdk", "iphoneos SDK path") orelse "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk";
    metal.addSystemFrameworkPath(.{ .cwd_relative = b.pathJoin(&.{ sdk, "System/Library/Frameworks" }) });
    metal.addLibraryPath(.{ .cwd_relative = b.pathJoin(&.{ sdk, "usr/lib" }) });
    metal.addSystemIncludePath(.{ .cwd_relative = b.pathJoin(&.{ sdk, "usr/include" }) });

    const lanes = module(b, "zig/src/core/lanes/lanes.zig", target, optimize);
    const fabric = module(b, "zig/src/fabric/fabric.zig", target, optimize);
    fabric.addImport("verbs", module(b, "zig/src/fabric/verbs.zig", target, optimize));
    const sources = b.createModule(.{ .root_source_file = b.path(b.pathJoin(&.{ upstream, "zig/kernels/metal/sources.zig" })) });
    const living = module(b, "zig/src/living/living.zig", target, optimize);
    const draft_files = b.addWriteFiles();
    _ = draft_files.addCopyFile(b.path(b.pathJoin(&.{ upstream, "zig/src/families/nemotron/draft_ids.txt" })), "draft_ids.txt");
    const draft = b.createModule(.{ .root_source_file = draft_files.add("draft_ids.zig", "pub const text = @embedFile(\"draft_ids.txt\");\n") });
    const engine = module(b, "zig/src/tensorfold.zig", target, optimize);
    engine.addImport("metal", metal);
    engine.addImport("kernel_sources", sources);
    engine.addImport("nemotron_draft_ids", draft);
    engine.addImport("lanes", lanes);
    engine.addImport("fabric", fabric);
    engine.addImport("living", living);

    // Qwen's shared compile-time kernel/source registry, matching upstream's qwen27 engine modules.
    engine.addImport("core", engine);
    const delta = module(b, "zig/src/core/deltanet_kernels.zig", target, .safe);
    delta.addImport("metal", metal);
    delta.addImport("kernel_sources", sources);
    engine.addImport("core_delta", delta);
    const files = b.addWriteFiles();
    var index: []const u8 = "";
    const parts = [_][]const u8{ "xsum", "norm_xs", "norm_input", "mlp_xs", "mlp_ane", "glue", "copy", "moe", "moe_rows", "attention_mpp", "attention_io", "attention_prompt", "attention_prompt_sg" };
    for (parts) |part| {
        _ = files.addCopyFile(b.path(b.pathJoin(&.{ upstream, "zig/kernels/metal/qwen27", b.fmt("{s}.metal", .{part}) })), b.fmt("{s}.metal", .{part}));
        index = b.fmt("{s}pub const {s} = @embedFile(\"{s}.metal\");\n", .{ index, part, part });
    }
    _ = files.addCopyFile(b.path(b.pathJoin(&.{ upstream, "zig/kernels/metal/core/deltanet.metal" })), "gdn.metal");
    _ = files.addCopyFile(b.path(b.pathJoin(&.{ upstream, "zig/kernels/metal/core/deltanet_slots.metal" })), "gdn_slots.metal");
    engine.addImport("qwen_runtime_sources", b.createModule(.{ .root_source_file = files.add("qwen_runtime_sources.zig", index) }));
    engine.addImport("qwen_gdn_source", b.createModule(.{ .root_source_file = files.add("qwen_gdn_source.zig", "pub const text = @embedFile(\"gdn.metal\") ++ \"\\n\" ++ @embedFile(\"gdn_slots.metal\");\n") }));
    const bf16 = module(b, "zig/src/core/bf16_topk.zig", target, .safe);
    engine.addImport("bf16_topk", bf16);
    const bf16_gpu = module(b, "zig/src/core/bf16_topk_gpu.zig", target, .safe);
    bf16_gpu.addImport("metal", metal);
    bf16_gpu.addImport("bf16_topk", bf16);
    bf16_gpu.addImport("bf16_topk_sources", b.createModule(.{ .root_source_file = b.path(b.pathJoin(&.{ upstream, "zig/bf16_topk_sources.zig" })) }));
    engine.addImport("bf16_topk_gpu", bf16_gpu);
    const tree = module(b, "zig/src/core/tree_round.zig", target, .safe);
    const tree_gpu = module(b, "zig/src/core/tree_round_gpu.zig", target, .safe);
    tree_gpu.addImport("metal", metal);
    tree_gpu.addImport("tree_round", tree);
    tree_gpu.addImport("tree_round_sources", b.createModule(.{ .root_source_file = b.path(b.pathJoin(&.{ upstream, "zig/tree_round_sources.zig" })) }));
    engine.addImport("tree_round", tree);
    engine.addImport("tree_round_gpu", tree_gpu);
    const commit = module(b, "zig/src/core/tree_commit_gpu.zig", target, .safe);
    commit.addImport("metal", metal);
    commit.addImport("tree_round", tree);
    commit.addImport("tree_commit_sources", b.createModule(.{ .root_source_file = b.path(b.pathJoin(&.{ upstream, "zig/tree_commit_sources.zig" })) }));
    engine.addImport("tree_commit_gpu", commit);
    const draft_ops = module(b, "zig/src/core/draft_ops.zig", target, .safe);
    draft_ops.addImport("metal", metal);
    draft_ops.addImport("draft_ops_sources", b.createModule(.{ .root_source_file = b.path(b.pathJoin(&.{ upstream, "zig/draft_ops_sources.zig" })) }));
    engine.addImport("draft_ops", draft_ops);

    const api = module(b, "zig/src/core/engine_api.zig", target, optimize);
    api.addImport("lanes", lanes);
    engine.addImport("engine_api", api);

    const phone_families = module(b, "zig/src/native/phone_families.zig", target, optimize);
    phone_families.addImport("metal", metal);
    phone_families.addImport("engine_api", api);
    phone_families.addImport("tensorfold", engine);
    phone_families.addImport("core", engine);
    phone_families.addImport("living", living);

    const phone = b.createModule(.{ .root_source_file = b.path("src/phone_metal.zig"), .target = target, .optimize = optimize, .link_libc = true });
    phone.addImport("engine_api", api);
    phone.addImport("phone_families", phone_families);

    const tokenizer = module(b, "zig/src/core/tokenizer/tokenizer.zig", target, optimize);
    const template = module(b, "zig/src/core/template/template.zig", target, optimize);
    const hf_text = module(b, "zig/src/server/hf_text.zig", target, optimize);
    hf_text.addImport("tokenizer", tokenizer);
    hf_text.addImport("template", template);
    const json = module(b, "zig/src/server/json.zig", target, optimize);
    hf_text.addImport("json", json);
    const dsv41 = module(b, "zig/src/families/deepseek_v41/serve/template.zig", target, optimize);
    dsv41.addImport("json", json);
    hf_text.addImport("dsv41_chat", dsv41);
    hf_text.addImport("uocr_chat", module(b, "zig/src/families/uocr/chat.zig", target, optimize));
    hf_text.addImport("drama_prompt", module(b, "zig/src/families/drama3/prompt.zig", target, optimize));
    hf_text.addImport("zonos_request", module(b, "zig/src/families/zonos3/request.zig", target, optimize));
    hf_text.addImport("living", living);

    const shims = b.addWriteFiles();
    const rope_shim = b.createModule(.{
        .root_source_file = shims.add("rope_freq_shim.zig",
            \\const r = @import("core").rope_freq;
            \\pub const inverseFrequencies = r.inverseFrequencies;
            \\pub const proportional = r.proportional;
            \\
        ),
        .target = target,
        .optimize = optimize,
        .imports = &.{.{ .name = "core", .module = engine }},
    });
    const st_shim = b.createModule(.{
        .root_source_file = shims.add("safetensors_shim.zig",
            \\const st = @import("core").safetensors;
            \\pub const DType = st.DType;
            \\pub const Header = st.Header;
            \\pub const Tensor = st.Tensor;
            \\pub const max_rank = st.max_rank;
            \\pub const headerSize = st.headerSize;
            \\pub const index = st.index;
            \\pub const parseHeader = st.parseHeader;
            \\pub const parseHeaderPrefix = st.parseHeaderPrefix;
            \\
        ),
        .target = target,
        .optimize = optimize,
        .imports = &.{.{ .name = "core", .module = engine }},
    });
    engine.addImport("rope_freq", rope_shim);
    engine.addImport("safetensors", st_shim);

    root.addImport("engine_api", api);
    root.addImport("phone_backend", phone);
    root.addImport("tensorfold", engine);
    root.addImport("hf_text", hf_text);
    wireExisting(b, root, "mobile_threaded", mobile_io);

    const registrations = [_][2][]const u8{
        .{ "sys", "zig/src/platform/sys.zig" },
        .{ "profile", "zig/src/core/profile.zig" },
        .{ "checkpoint_config", "zig/src/core/checkpoint_config.zig" },
        .{ "save_guard", "zig/src/core/save_guard.zig" },
        .{ "bf16_round", "zig/src/core/bf16_round.zig" },
        .{ "qwen35_layers", "zig/src/core/qwen35_layers.zig" },
        .{ "qwen35_rules", "zig/src/core/qwen35_rules.zig" },
        .{ "rope_config", "zig/src/core/rope_config.zig" },
        .{ "config_fields", "zig/src/core/config_fields.zig" },
        .{ "checkpoint_eos", "zig/src/core/tokenizer/eos.zig" },
        .{ "flashnext_memory", "zig/src/families/flashnext/load_memory.zig" },
    };
    for (registrations) |registration| wireShared(b, root, registration[0], registration[1]);
}

fn wireShared(b: *std.Build, root: *std.Build.Module, name: []const u8, relative: []const u8) void {
    var seen_modules: std.AutoHashMapUnmanaged(*std.Build.Module, void) = .empty;
    var walker = SharedWalker{ .b = b, .name = name, .relative = relative, .seen_modules = &seen_modules, .shared = null };
    walker.moduleTree(root);
}
fn wireExisting(b: *std.Build, root: *std.Build.Module, name: []const u8, existing: *std.Build.Module) void {
    var seen_modules: std.AutoHashMapUnmanaged(*std.Build.Module, void) = .empty;
    var walker = SharedWalker{ .b = b, .name = name, .relative = null, .seen_modules = &seen_modules, .shared = existing };
    walker.moduleTree(root);
}

const SharedWalker = struct {
    b: *std.Build,
    name: []const u8,
    relative: ?[]const u8,
    seen_modules: *std.AutoHashMapUnmanaged(*std.Build.Module, void),
    shared: ?*std.Build.Module,

    fn moduleTree(self: *SharedWalker, current: *std.Build.Module) void {
        if ((self.seen_modules.getOrPut(self.b.allocator, current) catch @panic("OOM")).found_existing) return;
        const target = current.resolved_target orelse self.b.graph.host;
        if (current.root_source_file) |root| {
            if (root == .src_path) {
                const shared_root = if (self.relative) |relative| std.mem.endsWith(u8, root.src_path.sub_path, relative) else false;
                if (!shared_root and !current.import_table.contains(self.name)) {
                    if (self.shared == null) self.shared = module(self.b, self.relative.?, target, .safe);
                    current.addImport(self.name, self.shared.?);
                }
            }
        }
        for (current.import_table.values()) |dependency| self.moduleTree(dependency);
    }
};
