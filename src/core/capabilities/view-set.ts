/**
 * summer_view_set / engine.view_set (PRODUCT-SPEC J17): an outside agent shows
 * the person what it works on, through the engine's SetView op: the view, the
 * right rail, what to focus, and the nodes to frame the camera on.
 */
export function viewSetOp(args: { view: string; rail?: string; focus?: string; frame?: string[] }): Record<string, unknown> {
  const op: Record<string, unknown> = { op: "SetView", view: args.view };
  if (args.rail) op.rail = args.rail;
  if (args.focus) op.focus = args.focus;
  if (args.frame?.length) op.frame = args.frame;
  return op;
}
