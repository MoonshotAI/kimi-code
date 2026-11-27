# Kimi-GeometryLab

Computational geometry and engineering laboratory coordinated with Kimi Code.

## Initial objective

Build a reproducible pipeline for:
1. Parametric and implicit geometry.
2. SDF-based geometry generation.
3. Surface mesh generation and validation.
4. Geometry export and visualization.
5. Future meshing, simulation and machine learning integration.

## Current baseline

The first executable example is a hollow tube generated with PicoGK.

- Outer radius: 20 mm
- Inner radius: 15 mm
- Length: 100 mm
- Voxel size: 0.5 mm
- Output: results/tube.stl

The STL has been generated and its dimensions and approximate volume checked.
Its topology still contains non-manifold edges and degenerate triangles.
It is not yet a validated mesh.

## Architecture

- agents/: planned specialist agents.
- engineering/: original engineering code and parametric models.
- engines/: local external engine checkouts.
- mcp/: planned MCP tool servers.
- results/: generated geometry and logs.
- tests/: automated tests.
- docs/: architecture, dependencies and validation.

Agents and MCP servers are organizational scaffolding, not implemented services.

## Engineering rules

- Keep upstream engines separate from original laboratory code.
- Record exact dependency revisions.
- Do not mix B-rep, mesh, voxel, SDF or VDB without explicit adapters.
- Preserve units, tolerances and reproducible parameters.
- Validate geometry and topology before simulation or ML.
