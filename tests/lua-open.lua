local options = rex.args
local layout = rex.layout
local actions = {}
local selected = nil
local focused = nil
local opened = 0
local label = "workrex/test [wr:test]"
local window_id = "window:test"

rex = {
  layout = layout,
  action = function(action)
    actions[action.name] = action.run
  end,
  call = function(method, args)
    if method == "session.list" then
      return { sessions = { { session_id = "session:test" } } }
    end
    if method == "session.view" then
      return { windows = options.existing and { { window_id = window_id, label = label } } or {} }
    end
    if method == "session.new_window" then
      opened = opened + 1
      return { window_id = window_id, block_ids = { "block:editor", "block:agent" } }
    end
    if method == "session.focus_window" then
      focused = args.window_id
      return {}
    end
    error("Unexpected API call: " .. method, 0)
  end,
  session = {
    focus_block = function(args)
      focused = args.block_id
      return {}
    end,
  },
  client = {
    queue = function(name, args)
      if options.fail_selection then
        error("Rex.app is not accepting actions. Turn on Remote Control.", 0)
      end
      selected = { name = name, args = args }
    end,
  },
}

dofile(options.module)
local result = actions.wr_open({}, {
  session_id = "session:test", window_id = options.existing and window_id or nil,
  label = label, cwd = "/test",
  panes = {
    { command = { "nvim", "." } },
    { command = { "pi" }, split = "horizontal", percentage = 40, focus = true },
  },
})
return { result = result, selected = selected, focused = focused, opened = opened }
