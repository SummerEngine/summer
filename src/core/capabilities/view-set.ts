/**
 * summer_view_set / engine.view_set (PRODUCT-SPEC J17): an outside agent shows
 * the person what it works on. The engine's Navigate op, target "view":
 * name = the view, tab = the right rail, path = what to focus.
 */
export function viewSetOp(args: { view: string; rail?: string; focus?: string }): Record<string, unknown> {
  const op: Record<string, unknown> = { op: "Navigate", target: "view", name: args.view };
  if (args.rail) op.tab = args.rail;
  if (args.focus) op.path = args.focus;
  return op;
}
