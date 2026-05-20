# ============================================================================
# Schedule Structure Tree + Segment Collection
# ============================================================================

using GeneRegulatorySystems.Models
using GeneRegulatorySystems.Models: Wrapped, Label, Descriptions
using GeneRegulatorySystems.Models.Plumbing
using GeneRegulatorySystems.Models.Scheduling
using GeneRegulatorySystems.Models.Scheduling: Primitive, Schedule as GRSSchedule
using GeneRegulatorySystems.Specifications
using GeneRegulatorySystems.Specifications: Scope, List, Each, Load, Template, Slice

# ============================================================================
# Label Extraction
# ============================================================================

_label(wrapped::Models.Wrapped) = _label(Models.describe(wrapped.definition))
_label(label::Models.Label) = label.label
_label(::Models.EmptyDescription) = ""
_label(x) = _type_label(x)

function _label(model::Plumbing.Adjust)
    op = try nameof(model.adjust) catch; :adjust end
    entries = join(
        ("  $(k): $(v)" for (k, v) in sort(collect(model.adjustment), by = first ∘ string)),
        "\n",
    )
    body = "Adjust ($(op))"
    isempty(entries) ? body : "$(body)\n$(entries)"
end

function _label(model::Plumbing.Seed)
    "Seed\n  $(model.seed)"
end

function _label(desc::Descriptions)
    i = findfirst(d -> d isa Label, desc.descriptions)
    i !== nothing ? _label(desc.descriptions[i]) : ""
end

"""Human-readable label derived from a model's type name."""
function _type_label(x)::String
    name = string(nameof(typeof(x)))
    words = replace(name, r"([a-z])([A-Z])" => s"\1 \2")
    return lowercase(words)
end

# ============================================================================
# Bindings Helpers
# ============================================================================

# ============================================================================
# Segment Collection
# ============================================================================

"""
Collect all raw segments, gene names, and gene colours from a single dryrun pass.
Gene colours are generated per-model using dispatch (`_gene_colours`).
Returns `(segments, gene_names, gene_colours)` — deduplicated per model_path.
"""
function _collect_segments(grs_schedule)::Tuple{Vector{TimelineSegment}, Vector{String}, Dict{String, String}}
    segments = TimelineSegment[]
    next_id = Ref(1)
    genes = String[]
    genes_seen = Set{String}()
    gene_colours = Dict{String, String}()
    seen_model_paths = Set{String}()

    function dryrun_collector(primitive!, x, Δt; path, into=nothing, _...)
        is_instant = !isfinite(Δt) || Δt == 0.0 || Models.unwrap(primitive!.f!) isa Models.Instant
        user_label = is_instant ? nothing : get(primitive!.bindings, :label, nothing)
        label = user_label isa AbstractString ? user_label : _label(primitive!.f!.model)
        model_path = primitive!.path
        push!(segments, TimelineSegment(
            id = next_id[],
            execution_path = path,
            model_path = model_path,
            json_path = model_path_to_json_path(model_path),
            from = x.t,
            to = x.t + (isfinite(Δt) ? Δt : 0.0),
            label = label,
            channel = something(into, ""),
        ))
        next_id[] += 1

        if model_path ∉ seen_model_paths && isfinite(Δt) && Δt > 0.0
            push!(seen_model_paths, model_path)
            for name in _gene_names(primitive!)
                s = string(name)
                if s ∉ genes_seen
                    push!(genes_seen, s)
                    push!(genes, s)
                end
            end
            merge!(gene_colours, _gene_colours(primitive!))
        end
    end

    # `parallel = false` keeps branched dryruns single-threaded — the shared
    # `segments` / `genes` / `gene_colours` are not thread-safe, and dryrun
    # does no real compute so there's nothing to gain from parallelism.
    grs_schedule(Models.FlatState(); dryrun = dryrun_collector, parallel = false)
    return (segments, genes, gene_colours)
end

"""
Merge contiguous segments with the same execution_path, label, and model_path.
Non-contiguous segments with the same path stay separate.
IDs are reassigned after merging.
"""
function _merge_contiguous_segments(segments::Vector{TimelineSegment})::Vector{TimelineSegment}
    isempty(segments) && return TimelineSegment[]

    merged = TimelineSegment[]
    current = segments[1]

    for i in 2:length(segments)
        seg = segments[i]
        if seg.execution_path == current.execution_path &&
           seg.label == current.label &&
           seg.model_path == current.model_path &&
           seg.channel == current.channel &&
           seg.from == current.to
            current = TimelineSegment(
                id = current.id,
                execution_path = current.execution_path,
                model_path = current.model_path,
                json_path = current.json_path,
                from = current.from,
                to = seg.to,
                label = current.label,
                channel = current.channel,
            )
        else
            push!(merged, current)
            current = seg
        end
    end
    push!(merged, current)

    return [TimelineSegment(
        id = i,
        execution_path = seg.execution_path,
        model_path = seg.model_path,
        json_path = seg.json_path,
        from = seg.from,
        to = seg.to,
        label = seg.label,
        channel = seg.channel,
    ) for (i, seg) in enumerate(merged)]
end

# ============================================================================
# Structure Tree
# ============================================================================

"""Walk the Schedule specification tree to produce a StructureNode hierarchy."""
function _build_structure_tree(grs_schedule::GRSSchedule)::StructureNode
    return _structure_node(grs_schedule.specification, grs_schedule.bindings, grs_schedule.path, grs_schedule.branch)
end

function _structure_node(spec::Scope, bindings::Dict{Symbol, Any}, path::String, branch::Bool)::StructureNode
    child_path = "$path$(spec.branch ? '/' : '+')"
    merged_bindings = _safe_evaluate_bindings(spec, bindings, path)
    child = _structure_node_from_step(spec.step, merged_bindings, child_path, spec.branch)

    if haskey(merged_bindings, :to)
        return StructureNode(type = :scope, execution_path = child_path, label = "repeat", children = [child])
    end

    return StructureNode(type = :scope, execution_path = child_path, children = [child])
end

function _structure_node(spec::List, bindings::Dict{Symbol, Any}, path::String, branch::Bool)::StructureNode
    child_prefix = branch ? path : "$path-"
    children = StructureNode[]

    for (i, item_spec) in enumerate(spec.items)
        item_bindings = Scheduling.descended(bindings, i)
        child = _structure_node_from_step(item_spec, item_bindings, "$child_prefix$i", false)
        push!(children, child)
    end

    node_type = (branch || any(_subtree_has_branch, children)) ? :branch : :sequence
    return StructureNode(type = node_type, execution_path = path, children = children)
end

function _structure_node(spec::Each, bindings::Dict{Symbol, Any}, path::String, branch::Bool)::StructureNode
    child_prefix = branch ? path : "$path-"

    items = try
        Scheduling.evaluate(spec.items; bindings, path)
    catch
        []
    end

    children = StructureNode[]
    for (i, item) in enumerate(items)
        item_bindings = Scheduling.descended(bindings, i)
        if spec.as != Symbol("")
            item_bindings = merge(item_bindings, Dict{Symbol, Any}(spec.as => item))
        end
        child = _structure_node_from_step(spec.step, item_bindings, "$child_prefix$i", false)
        push!(children, child)
    end

    node_type = (branch || any(_subtree_has_branch, children)) ? :branch : :sequence
    return StructureNode(type = node_type, execution_path = path, children = children)
end

"""True if this node or any descendant has type :branch."""
function _subtree_has_branch(node::StructureNode)::Bool
    node.type == :branch && return true
    any(_subtree_has_branch, node.children)
end

function _structure_node(spec::Template, bindings::Dict{Symbol, Any}, path::String, branch::Bool)::StructureNode
    expanded = try
        Scheduling.evaluate(spec; bindings, path)
    catch
        nothing
    end

    if expanded isa Specifications.Specification
        return _structure_node(expanded, bindings, path, branch)
    end

    return StructureNode(type = :leaf, execution_path = path, label = _safe_label(expanded))
end

function _structure_node(spec::Slice, bindings::Dict{Symbol, Any}, path::String, branch::Bool)::StructureNode
    return StructureNode(type = :leaf, execution_path = path, label = "slice")
end

function _structure_node(spec::Load, bindings::Dict{Symbol, Any}, path::String, branch::Bool)::StructureNode
    return StructureNode(type = :leaf, execution_path = path, label = "load: $(spec.path)")
end

function _structure_node(spec, bindings::Dict{Symbol, Any}, path::String, branch::Bool)::StructureNode
    return StructureNode(type = :leaf, execution_path = path)
end

function _structure_node_from_step(step, bindings::Dict{Symbol, Any}, path::String, branch::Bool)::StructureNode
    if step isa Specifications.Specification
        return _structure_node(step, bindings, path, branch)
    end
    return StructureNode(type = :leaf, execution_path = path, label = _safe_label(step))
end

function _safe_evaluate_bindings(spec::Scope, bindings::Dict{Symbol, Any}, path::String)::Dict{Symbol, Any}
    try
        merged = if spec.barrier
            Dict{Symbol, Any}(
                keep => bindings[keep]
                for keep in (:seed, :into, :channel, :defaults)
                if haskey(bindings, keep)
            )
        else
            copy(bindings)
        end

        for (name, definition) in spec.definitions
            try
                merged[name] = Scheduling.evaluate(definition, path = "$path.$name"; bindings)
                merged[Symbol("^$name")] = Scheduling.Locator(path)
            catch
                @debug "Could not evaluate binding" name path
            end
        end
        return merged
    catch
        return bindings
    end
end

_safe_label(x::Models.Model) = _label(x)
_safe_label(x::Models.Wrapped) = _label(x)
_safe_label(x::Number) = "step=$x"
_safe_label(::Nothing) = ""
_safe_label(x) = string(typeof(x))
