# summer_align_distribute_3d

Align or equal-space an explicit ordered list of 3D subjects along one world-space axis, then save the exact target scene.

Every anchor and extent comes from visible descendant GeometryInstance3D world AABBs (evidence: visual_aabb). The tool never uses editor selection and fails instead of fabricating bounds. It preserves each subject's authored basis and scale, translates only along the normalized axis, and records all changed transforms in one undoable editor operation.

Alignment modes use the first ordered subject's minimum, center, or maximum projected anchor. Distribution modes keep the first and last subjects fixed and honor caller order. distribute_gaps accounts for each subject's projected half-extent and fails if the endpoint span cannot fit non-overlapping equal gaps. The compact result returns ordered before/after origins, resolved spacing, and numeric residuals under 5 KB. On an engine build that predates AlignDistribute3D the result is a structured engine_lacks_op failure naming the fallback.
