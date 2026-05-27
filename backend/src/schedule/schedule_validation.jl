# ============================================================================
# Schedule Validation
# ============================================================================

using GeneRegulatorySystems.Models
using ..ScheduleBindings: spec_bindings

"""
    validate_spec(spec) -> Vector{ValidationMessage}

Validate a parsed schedule specification by attempting to construct a Model.
Returns validation messages (info/warning/error).
"""
function validate_spec(spec::AbstractDict{Symbol})::Vector{ValidationMessage}
    messages = ValidationMessage[]

    if isempty(spec)
        push!(messages, ValidationMessage(type="error", content="Schedule specification is empty"))
        return messages
    end

    if haskey(spec, :seed)
        if !isa(spec[:seed], String)
            push!(messages, ValidationMessage(type="warning", content="Seed should be a string (got $(typeof(spec[:seed])))"))
        end
    else
        push!(messages, ValidationMessage(type="info", content="No seed specified (will use default)"))
    end

    try_construct_model!(messages, spec, get(spec, :seed, "default"))
    return messages
end

function validate_spec(spec::AbstractVector)::Vector{ValidationMessage}
    messages = ValidationMessage[]

    if isempty(spec)
        push!(messages, ValidationMessage(type="error", content="Schedule specification is empty"))
        return messages
    end

    push!(messages, ValidationMessage(type="info", content="No seed specified (will use default)"))

    try_construct_model!(messages, spec, "default")
    return messages
end

"""Try constructing a Model from the spec; push an error message on failure."""
function try_construct_model!(messages::Vector{ValidationMessage}, spec, seed::String)
    try
        Models.Model(spec; bindings = spec_bindings(spec))
    catch e
        readable = sprint(showerror, e)
        push!(messages, ValidationMessage(type="error", content=readable))
    end
end
