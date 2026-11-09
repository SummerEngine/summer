# summer_enable_plugin

Enable an editor plugin in the open project (res://addons/<name>/, for example one paired with a Summer App) and report the real result: enabled with the autoloads it registered, or why it failed (code SCRIPT_ERROR, NOT_TOOL, NOT_EDITOR_PLUGIN, CFG_MISSING, TIMEOUT, ...). Older Summer Engine builds only queue the enable; then the result says queued: true and enabled: null, and you check summer_get_debugger_errors before relying on the plugin.
