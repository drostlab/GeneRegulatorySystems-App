# ============================================================================
# Network Extraction & Union Network Building
# ============================================================================

using JSON
using ..NetworkRepresentation

# ============================================================================
# model_path to JSONPath conversion
# ============================================================================

"""
    model_path_to_json_path(model_path) -> Vector{Any}

Convert an internal model_path string (e.g. `"+-1.do"`) to a JSONPath segment
array suitable for use with `jsonc-parser`'s `findNodeAtLocation`.

Encoding rules:
- `+` or `/`  -> descend into the `"step"` key (scope entry)
- `-`          -> list separator, no JSON descent
- digits       -> 0-based array index (Julia paths are 1-based)
- `.name`      -> descend into binding key `name`
"""
function model_path_to_json_path(model_path::String)::Vector{Any}
    result = Any[]
    chars = collect(model_path)
    n = length(chars)
    i = 1
    while i <= n
        c = chars[i]
        if c == '+' || c == '/'
            push!(result, "step")
            i += 1
        elseif c == '-'
            i += 1
        elseif c == '.'
            j = i + 1
            while j <= n && chars[j] ∉ ('+', '/', '-', '.')
                j += 1
            end
            push!(result, String(chars[i+1:j-1]))
            i = j
        elseif isdigit(c)
            j = i
            while j <= n && isdigit(chars[j])
                j += 1
            end
            push!(result, parse(Int, String(chars[i:j-1])) - 1)  # 0-based
            i = j
        else
            i += 1
        end
    end
    return result
end

# ============================================================================
# Helpers
# ============================================================================

function _unique_model_paths(segments::Vector{TimelineSegment})::Vector{String}
    seen = Set{String}()
    paths = String[]
    for seg in segments
        seg.from == seg.to && continue
        if seg.model_path ∉ seen
            push!(seen, seg.model_path)
            push!(paths, seg.model_path)
        end
    end
    return paths
end

function _property_signature(properties::Dict{Symbol, Any})::String
    isempty(properties) && return ""
    parts = String[]
    for (k, v) in sort(collect(properties); by = kv -> string(first(kv)))
        push!(parts, "$(String(k))=" * _value_signature(v))
    end
    return join(parts, ";")
end

function _value_signature(x)::String
    if x isa Dict
        entries = sort(collect(x); by = kv -> string(first(kv)))
        inner = String["$(string(k)):" * _value_signature(v) for (k, v) in entries]
        return "{" * join(inner, ",") * "}"
    elseif x isa AbstractVector
        return "[" * join((_value_signature(v) for v in x), ",") * "]"
    elseif x isa Tuple
        return "(" * join((_value_signature(v) for v in x), ",") * ")"
    elseif x isa Symbol
        return ":" * String(x)
    elseif x === nothing
        return "null"
    elseif x isa AbstractString
        return JSON.json(x)
    elseif x isa Number || x isa Bool
        return string(x)
    end
    return repr(x)
end

function _link_id(l::NetworkRepresentation.Link)::String
    # Link identity is topological (kind/from/to/scope) only. Parameter values
    # differ per model and are surfaced via `parameters_by_model_path`, so they
    # must not fork the union link.
    return "$(l.from)-$(l.kind)-$(l.to)-$(l.scope)"
end
