# summer_repeat_along

Instance copies of one scene along a straight line in one call: wall clamps every 0.45 m, braces every 0.8 m, fence posts, a row of window modules. Give start plus end (with spacing or count) or start plus direction (with count and spacing); positions are in the parent's local space. align (start|center|end) places the leftover length when spacing does not divide the line. Each copy is an InstantiateScene (the engine runs each alone), named <namePrefix>_<n>; the copies' transforms (position, rotationDegrees, scale) are then set in one request and the scene is saved once: N copies cost N + 2 engine requests. At most 64 copies per call.

Returns a compact receipt: {count, spacing, first, last, created [node paths], renamed, failures [{index, error}], saved}. Lists are cut to stay under 5 KB and the cut is declared.
