"""
    ScheduleStorage

Manages schedule persistence with two sources:
- examples_dir: read-only curated schedules (committed, ships with app)
- data_dir/schedules: user-created schedules (runtime, gitignored)

All schedule files are stored flat as {name}.schedule.json.
"""
module ScheduleStorage

using Logging

export list_all_schedules, get_schedule_spec, save_user_schedule,
       schedule_exists, get_schedule_path, delete_user_schedule,
       set_examples_dir, set_data_dir

# ============================================================================
# Paths
# ============================================================================

"""Read-only directory for curated example schedules."""
const _examples_dir = Ref{String}(joinpath(@__DIR__, "..", "..", "examples"))

"""Read-write directory for user schedules."""
const _user_dir = Ref{String}(joinpath(@__DIR__, "..", "..", "data", "schedules"))

"""Set the read-only examples directory."""
function set_examples_dir(path::String)
    _examples_dir[] = path
    @debug "ScheduleStorage examples directory set" path
end

"""Set the read-write data directory (creates schedules/ subdirectory)."""
function set_data_dir(path::String)
    user_dir = joinpath(path, "schedules")
    mkpath(user_dir)
    _user_dir[] = user_dir
    @debug "ScheduleStorage user directory set" user_dir
end

# ============================================================================
# Path resolution
# ============================================================================

"""Validate a schedule name (no path traversal)."""
function _validate_name(name::String)
    contains(name, '/') && error("Invalid schedule name: $name")
    contains(name, '\\') && error("Invalid schedule name: $name")
    contains(name, "..") && error("Invalid schedule name: $name")
end

"""Resolve directory for a given source."""
function _source_dir(source::String)::String
    source == "examples" && return _examples_dir[]
    source == "user" && return _user_dir[]
    error("Invalid source: $source")
end

"""Get the file path for a schedule."""
function get_schedule_path(name::String, source::String)::String
    _validate_name(name)
    joinpath(_source_dir(source), "$(name).schedule.json")
end

# ============================================================================
# Listing
# ============================================================================

"""List schedule names from a single directory, prefixed with source."""
function _list_from_dir(dir::String, source::String)::Vector{String}
    isdir(dir) || return String[]
    names = String[]
    for file in readdir(dir)
        if endswith(file, ".schedule.json")
            name = replace(file, ".schedule.json" => "")
            push!(names, "$(source)/$(name)")
        end
    end
    names
end

"""List all available schedule keys in format "source/name"."""
function list_all_schedules()::Vector{String}
    schedules = vcat(
        _list_from_dir(_examples_dir[], "examples"),
        _list_from_dir(_user_dir[], "user"),
    )
    sort!(unique!(schedules))
end

# ============================================================================
# Loading
# ============================================================================

function schedule_exists(name::String, source::String)::Bool
    isfile(get_schedule_path(name, source))
end

"""Load raw schedule JSON. Returns nothing if not found."""
function get_schedule_spec(name::String, source::String)::Union{String, Nothing}
    path = get_schedule_path(name, source)
    isfile(path) || (@warn "Schedule not found" name source; return nothing)
    read(path, String)
end

# ============================================================================
# Saving (user schedules only)
# ============================================================================

"""Save a schedule to user storage."""
function save_user_schedule(name::String, json::String)::Bool
    mkpath(_user_dir[])
    path = get_schedule_path(name, "user")
    open(path, "w") do f
        write(f, json)
    end
    @debug "Saved user schedule" name path
    true
end

"""Delete a user schedule."""
function delete_user_schedule(name::String)::Bool
    path = get_schedule_path(name, "user")
    if isfile(path)
        rm(path)
        @debug "Deleted user schedule" name
    end
    true
end

end # module ScheduleStorage
