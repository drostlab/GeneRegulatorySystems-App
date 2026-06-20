# ============================================================================
# Schedule Validation
# ============================================================================

using GeneRegulatorySystems.Models
using GeneRegulatorySystems.Specifications
using ..ScheduleBindings: spec_bindings

"""Return the template name when `e` is an unknown specification constructor."""
function unsupported_constructor_name(e)::Union{Symbol, Nothing}
    e isa MethodError || return nothing
    e.f === Specifications.constructor || return nothing
    isempty(e.args) && return nothing

    argument_type = typeof(first(e.args))
    argument_type <: Val || return nothing
    parameters = argument_type.parameters
    length(parameters) == 1 && first(parameters) isa Symbol || return nothing
    return first(parameters)
end

"""Turn JSON.jl parser diagnostics into a short message suitable for the UI."""
function json_error_message(message::AbstractString)::Union{String, Nothing}
    startswith(lowercase(message), "invalid json") || return nothing

    line_match = match(r"\(line (\d+)\)", message)
    location = line_match === nothing ? "" : " on line $(line_match.captures[1])"

    explanation = if occursin("ExpectedOpeningQuoteChar", message)
        "Expected a property name in double quotes; check for a missing quote or an extra character near this line."
    elseif occursin("ExpectedColon", message)
        "Expected a colon after a property name."
    elseif occursin("ExpectedComma", message)
        "Expected a comma between values."
    elseif occursin("UnexpectedEOF", message)
        "The file ends before the JSON value is complete; check for a missing quote or closing bracket."
    else
        "Check for a missing comma, quote, or closing bracket near this line."
    end

    return "Invalid JSON$location. $explanation"
end

"""Convert backend exceptions into concise, actionable validation messages."""
function schedule_error_message(e)::String
    constructor_name = unsupported_constructor_name(e)
    if constructor_name !== nothing
        return "Unsupported constructor “{$constructor_name}”. "
    elseif e isa KeyError
        return "The schedule refers to a missing field or value: $(repr(e.key))."
    elseif e isa ArgumentError
        json_message = json_error_message(string(e.msg))
        json_message === nothing || return json_message
        return "The schedule contains an invalid value: $(e.msg)"
    elseif e isa MethodError
        return "A schedule value has an unsupported type or shape. " *
               "Check that the feature's fields and value types match the schedule format."
    end

    return "The schedule could not be processed: $(sprint(showerror, e))"
end

"""
    _validate_spec(spec) -> Vector{ValidationMessage}

Validate a parsed schedule specification by attempting to construct a Model.
Returns validation messages (info/warning/error).
"""
function _validate_spec(spec::AbstractDict{Symbol})::Vector{ValidationMessage}
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
        push!(messages, ValidationMessage(type="info", content="No seed specified"))
    end

    _try_construct_model!(messages, spec, get(spec, :seed, "default"))
    return messages
end

function _validate_spec(spec::AbstractVector)::Vector{ValidationMessage}
    messages = ValidationMessage[]

    if isempty(spec)
        push!(messages, ValidationMessage(type="error", content="Schedule specification is empty"))
        return messages
    end

    push!(messages, ValidationMessage(type="info", content="No seed specified"))

    _try_construct_model!(messages, spec, "default")
    return messages
end

"""Try constructing a Model from the spec; push an error message on failure."""
function _try_construct_model!(messages::Vector{ValidationMessage}, spec, seed::String)
    try
        Models.Model(spec; bindings = spec_bindings(spec))
    catch e
        @error "Schedule validation failed" exception=(e, catch_backtrace())
        push!(messages, ValidationMessage(type="error", content=schedule_error_message(e)))
    end
end
