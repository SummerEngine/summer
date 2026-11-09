// Projects one painted picture onto every mesh that uses this material, from the fixed paint camera.
// UV = where the surface point sits in the paint camera's orthographic frame, so no mesh needs UVs.
// Unshaded: the painting already holds all the light. Keep the scene tonemap Linear, exposure 1.
shader_type spatial;
render_mode unshaded, cull_disabled, shadows_disabled;

uniform sampler2D paint : source_color, filter_linear_mipmap_anisotropic, repeat_disable;
uniform vec3 paint_origin;      // PaintCamera.global_position
uniform vec3 paint_right;       // PaintCamera.global_basis.x
uniform vec3 paint_up;          // PaintCamera.global_basis.y
uniform vec2 paint_size;        // frame width, height in metres (Camera3D.size with KEEP_WIDTH, height = width * H / W)

varying vec3 world_pos;

void vertex() {
	world_pos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	vec3 d = world_pos - paint_origin;
	vec2 uv = vec2(dot(d, paint_right) / paint_size.x + 0.5, 0.5 - dot(d, paint_up) / paint_size.y);
	ALBEDO = texture(paint, uv).rgb;
}
