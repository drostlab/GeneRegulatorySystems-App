# ============================================================================
# Segment Collection
#
# A single dryrun pass produces a flat list of enriched `TimelineSegment`s. The
# schedule topology (branches/sequences) is *not* re-derived here — it is carried
# faithfully by the engine's native `execution_path` grammar (`+ - / .`) and
# reconstructed on the frontend. See docs/schedule-view-redesign.md.
# ============================================================================

using GeneRegulatorySystems.Models
using GeneRegulatorySystems.Models: Wrapped, Label, Descriptions
using GeneRegulatorySystems.Models.Plumbing
using GeneRegulatorySystems.Models.Scheduling
using GeneRegulatorySystems.Models.Scheduling: Primitive, Schedule as GRSSchedule
using GeneRegulatorySystems.Specifications: Scope, Each, Sequence, Template, Slice

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
Collect the evaluated sequence metadata needed by the schedule view.

GRS's path grammar deliberately serialises both a non-branch `Each` and a `List`
with `-i`. This narrow walk over already parsed/evaluated `Schedule` objects
records that operator provenance together with authored labels and Each binding
values. It does not reconstruct models, timing, branches, or layout.
"""
function collect_schedule_metadata(grs_schedule::GRSSchedule)::Tuple{Vector{String}, Vector{ScheduleOperator}}
    prefixes = Set{String}()
    operators = ScheduleOperator[]
    collect_schedule_metadata!(prefixes, operators, grs_schedule)
    return (sort!(collect(prefixes)), operators)
end

function collect_schedule_metadata!(prefixes::Set{String}, operators::Vector{ScheduleOperator}, schedule::GRSSchedule{Scope})
    bindings = Scheduling.evaluate_bindings(schedule)
    path = "$(schedule.path)$(schedule.specification.branch ? '/' : '+')"
    step = Scheduling.model(
        schedule.specification.step;
        bindings,
        branch = schedule.specification.branch,
        path,
    )
    collect_schedule_metadata!(prefixes, operators, step)
end

function operator_value(value)::String
    value isa AbstractString && return String(value)
    value isa Union{Number, Symbol, Bool} && return string(value)
    return ""
end

function step_binding(step, key::Symbol)
    hasproperty(step, :bindings) || return nothing
    return get(getproperty(step, :bindings), key, nothing)
end

function collect_schedule_metadata!(prefixes::Set{String}, operators::Vector{ScheduleOperator}, schedule::GRSSchedule{<:Sequence})
    specification = schedule.specification
    specification isa Each && !schedule.branch && push!(prefixes, schedule.path)
    path = schedule.branch ? schedule.path : "$(schedule.path)-"
    steps = collect(Scheduling.models(specification; bindings = schedule.bindings, path))
    prefix = schedule.branch && endswith(schedule.path, "/") ? chop(schedule.path) : schedule.path
    binding = specification isa Each ? string(specification.as) : ""
    push!(operators, ScheduleOperator(
        path = prefix,
        kind = specification isa Each ? "each" : "list",
        parallel = schedule.branch || specification isa Each,
        label = string(something(get(schedule.bindings, :label, nothing), "")),
        binding = binding,
        child_paths = ["$(path)$(i)" for i in eachindex(steps)],
        child_values = [operator_value(binding == "" ? nothing : step_binding(step, Symbol(binding))) for step in steps],
        child_labels = [string(something(step_binding(step, :label), "")) for step in steps],
    ))
    for step in steps
        collect_schedule_metadata!(prefixes, operators, step)
    end
end

function collect_schedule_metadata!(prefixes::Set{String}, operators::Vector{ScheduleOperator}, schedule::GRSSchedule{Template})
    expanded = Scheduling.evaluate(schedule.specification; bindings = schedule.bindings, path = schedule.path)
    step = Scheduling.model(expanded; bindings = schedule.bindings, branch = schedule.branch, path = schedule.path)
    collect_schedule_metadata!(prefixes, operators, step)
end

function collect_schedule_metadata!(prefixes::Set{String}, operators::Vector{ScheduleOperator}, schedule::GRSSchedule{Slice})
    path = if haskey(schedule.bindings, :do)
        "$(schedule.bindings[Symbol("^do")].path).do"
    else
        schedule.path
    end
    step = Scheduling.model(
        get(schedule.bindings, :do, Plumbing.Wait());
        bindings = schedule.bindings,
        branch = schedule.branch,
        path,
    )
    collect_schedule_metadata!(prefixes, operators, step)
end

collect_schedule_metadata!(::Set{String}, ::Vector{ScheduleOperator}, ::Primitive) = nothing
collect_schedule_metadata!(::Set{String}, ::Vector{ScheduleOperator}, ::Any) = nothing

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

    function dryrun_collector(primitive!, x, Δt; path, _...)
        is_instant = !isfinite(Δt) || Δt == 0.0 || Models.unwrap(primitive!.f!) isa Models.Instant
        label = _label(primitive!.f!.model)
        scope_label = get(primitive!.bindings, :label, "")
        stage = get(primitive!.bindings, :stage, "")
        model_path = primitive!.path
        push!(segments, TimelineSegment(
            id = next_id[],
            execution_path = path,
            model_path = model_path,
            json_path = model_path_to_json_path(model_path),
            from = x.t,
            to = x.t + (isfinite(Δt) ? Δt : 0.0),
            model_type = string(nameof(typeof(Models.unwrap(primitive!)))),
            label = label,
            scope_label = scope_label isa AbstractString ? scope_label : "",
            stage = stage isa AbstractString ? stage : string(stage),
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

    grs_schedule(Models.FlatState(); dryrun = dryrun_collector)
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
           seg.model_type == current.model_type &&
           seg.scope_label == current.scope_label &&
           seg.stage == current.stage &&
           seg.from == current.to
            current = TimelineSegment(
                id = current.id,
                execution_path = current.execution_path,
                model_path = current.model_path,
                json_path = current.json_path,
                from = current.from,
                to = seg.to,
                model_type = current.model_type,
                label = current.label,
                scope_label = current.scope_label,
                stage = current.stage,
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
        model_type = seg.model_type,
        label = seg.label,
        scope_label = seg.scope_label,
        stage = seg.stage,
    ) for (i, seg) in enumerate(merged)]
end
