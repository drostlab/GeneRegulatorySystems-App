# ============================================================================
# Shared Schedule Bindings
# ============================================================================
#
# Canonical construction of the standard bindings dict used by GRS.jl's
# Model constructor, Specification, and Schedule. Shared across modules
# (ScheduleVisualization, Simulation) to avoid duplication.

module ScheduleBindings

using GeneRegulatorySystems.Models

export spec_seed, spec_bindings

"""Extract seed from a parsed spec (Dict or Vector)."""
spec_seed(spec::AbstractDict{Symbol}) = get(spec, :seed, "default")
spec_seed(::AbstractVector) = "default"

"""Build standard bindings dict from a parsed spec."""
function spec_bindings(spec)::Dict{Symbol, Any}
    seed = spec_seed(spec)
    Dict{Symbol, Any}(
        :rootseed => seed,
        :seed => seed,
        :into => "",
        :channel => "",
        :defaults => Models.load_defaults(),
    )
end

end # module ScheduleBindings
