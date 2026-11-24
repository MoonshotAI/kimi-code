---
"@moonshot-ai/kap-server": minor
---

Add `GET /api/v1/system/stats` and the `system_stats` capability. The response reports CPU usage since the previous request, memory, the file system that holds a given path, and NVIDIA GPU memory and load from `nvidia-smi`. Inside a container or job, cgroup v1 and v2 CPU quotas and memory limits replace the machine totals, and reclaimable file cache counts as free memory. A file system that stops answering is left out after two seconds without queueing more reads.
