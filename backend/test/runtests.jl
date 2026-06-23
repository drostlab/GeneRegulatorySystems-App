using Test

module ViewportTestHost
module Simulation
load_timeseries_for_species(args...) = error("not used by unit tests")
end

include("../src/simulation/viewport.jl")
end

using .ViewportTestHost.Viewport

@testset "count viewport remains OHLC-backed" begin
    raw = [(Float64(i), i % 3) for i in 0:100]
    pyramid = build_pyramid(raw)
    @test !isempty(query(pyramid, 0.0, 100.0, 10))
end

@testset "promoter viewport activity" begin
    raw = Tuple{Float64, Int}[(0.0, 0)]
    for second in 0:9
        push!(raw, (second + 0.1, 1))
        push!(raw, (second + 0.2, 0))
    end
    push!(raw, (10.0, 0))

    pyramid = build_pyramid(raw; activity=true)
    coarse = query_activity(pyramid, 0.0, 10.0, 8)

    @test length(coarse) == 3
    @test first.(coarse) == [0.0, 5.0, 10.0]
    @test all(value -> isapprox(value, 0.1; atol=1e-12), last.(coarse))

    # When transitions fit the point budget, preserve the exact digital trace.
    exact = query_activity(pyramid, 0.0, 10.0, 100)
    @test exact == [(time, Float64(value)) for (time, value) in raw]
end

@testset "promoter viewport gaps" begin
    raw = [(0.0, 1), (0.2, 1), (0.4, 1), (0.6, 1), (1.0 - 1e-9, 1),
           (1.0, GAP), (3.0 - 1e-9, GAP), (3.0, 0), (3.2, 0), (3.4, 0),
           (3.6, 0), (4.0, 0)]
    pyramid = build_pyramid(raw; activity=true)
    coarse = query_activity(pyramid, 0.0, 4.0, 16)

    @test coarse[1][2] == 1.0
    @test coarse[2][2] == GAP
    @test coarse[3][2] == GAP
    @test coarse[4][2] == 0.0
end
