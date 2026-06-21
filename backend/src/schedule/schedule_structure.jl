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
            model_type = string(nameof(typeof(Models.unwrap(primitive!)))),
            label = label,
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
    ) for (i, seg) in enumerate(merged)]
end
