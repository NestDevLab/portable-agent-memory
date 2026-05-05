# Migration: Partial Or Unknown PAM Layout To Graph V1

## Goal

Recover a usable PAM workspace when version metadata and memory files disagree.

## Procedure

1. Prefer explicit version metadata when it exists and is valid JSON.
2. Validate graph files if `memory/graph/catalog.json` exists.
3. If graph validation fails, classify the workspace as `partial`.
4. If no known PAM files exist, classify it as `unknown`.
5. For `partial`, preserve all files and repair the smallest missing graph
   artifact.
6. For `unknown`, run a setup/audit workflow before creating graph records.

Do not infer success from file existence alone. Version metadata and graph
validation both matter.
