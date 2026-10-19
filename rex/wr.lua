local function call(method, args)
  local result, err = rex.call(method, args)
  if err ~= nil then
    error(err, 0)
  end
  return result
end

local function shell_quote(arg)
  -- Escape outside the quotes: fish also interprets backslashes inside single quotes.
  return "'" .. arg:gsub("[\\']", function(char)
    return "'\\" .. char .. "'"
  end) .. "'"
end

local function window(args)
  local sessions = call("session.list", {}).sessions or {}
  local exists = false
  for _, session in ipairs(sessions) do
    if session.session_id == args.session_id then
      exists = true
    end
  end
  if not exists then
    return nil, false
  end

  if not args.window_id then
    return nil, true
  end

  local view = call("session.view", { session_id = args.session_id })
  for _, item in ipairs(view.windows or {}) do
    if item.window_id == args.window_id then
      return item, true
    end
  end
  return nil, true
end

local function status(args)
  local item, session_exists = window(args)
  local own = false
  if item and args.caller_block then
    for _, layer in ipairs(item.layers or {}) do
      for _, block in ipairs(layer.blocks or {}) do
        if block.block_id == args.caller_block then
          own = true
        end
      end
    end
  end
  return { window_id = item and item.window_id or false, session_exists = session_exists, own_tab = own }
end

rex.action {
  name = "wr_status",
  title = "Inspect workrex tab",
  args = { session_id = "string", window_id = "string?", caller_block = "string?" },
  run = function(_, args)
    return status(args)
  end,
}

rex.action {
  name = "wr_open",
  title = "Open workrex tab",
  args = {
    session_id = "string", window_id = "string?", label = "string", cwd = "string",
    panes = "array",
  },
  run = function(_, args)
    local item, session_exists = window(args)
    if not session_exists then
      error("Rex session no longer exists. Run add from a live Rex session.", 0)
    end

    local warning = nil
    if not item then
      if #args.panes < 1 then
        error("Expected at least one pane", 0)
      end

      local root = { pane = 1 }
      local blocks = {}
      local leaves = { root }
      local focus = nil
      for i, pane in ipairs(args.panes) do
        local command = pane.command
        if type(command) == "string" then
          if command == "" or command:find("\0", 1, true) then
            error("Pane command must be a nonempty string without NUL", 0)
          end
        elseif type(command) == "table" and #command > 0 then
          local quoted = {}
          for j, arg in ipairs(command) do
            if type(arg) ~= "string" then
              error("Command arguments must be strings", 0)
            end
            quoted[j] = shell_quote(arg)
          end
          command = table.concat(quoted, " ")
        else
          error("Pane command must be a nonempty string or argument array", 0)
        end

        blocks[i] = rex.layout.block {
          flavor = "com.superlogical.terminal.shell",
          options = { cwd = args.cwd, initial_input = command .. "\r" },
        }
        if pane.focus then
          if focus then
            error("Only one pane can have focus", 0)
          end
          focus = i
        end

        if i > 1 then
          -- Payloads without parent come from older clients, which always split the previous pane.
          local parent = pane.parent == nil and i - 1 or pane.parent
          if type(parent) ~= "number" or parent % 1 ~= 0 or parent < 1 or parent >= i then
            error("Invalid split parent", 0)
          end
          if pane.split ~= "horizontal" and pane.split ~= "vertical" then
            error("Invalid split direction", 0)
          end
          if type(pane.percentage) ~= "number" or pane.percentage % 1 ~= 0 or pane.percentage < 1 or pane.percentage > 99 then
            error("Invalid split percentage", 0)
          end

          local node = leaves[parent]
          node.pane = nil
          node.direction = pane.split
          node.ratio = 1 - pane.percentage / 100
          node.before = { pane = parent }
          node.after = { pane = i }
          leaves[parent] = node.before
          leaves[i] = node.after
        end
      end

      -- session.new_window returns block_ids in depth-first leaf order, before then after.
      local order = {}
      local function build(node)
        if node.pane then
          order[#order + 1] = node.pane
          return blocks[node.pane]
        end
        local before = build(node.before)
        local after = build(node.after)
        return rex.layout[node.direction](node.ratio, before, after)
      end
      local layout = build(root)

      local focused = 1
      for position, pane in ipairs(order) do
        if pane == focus then
          focused = position
        end
      end

      item = call("session.new_window", {
        session_id = args.session_id, window_label = args.label, layout = layout, focus = true,
      })
      local _, err = rex.session.focus_block { session_id = args.session_id, block_id = item.block_ids[focused] }
      if err ~= nil then
        warning = err
      end
    else
      call("session.focus_window", { session_id = args.session_id, window_id = item.window_id })
    end

    local selected, err = pcall(rex.client.queue, "session.select", {
      session_id = args.session_id, window_id = item.window_id,
    })
    if not selected then
      warning = tostring(err)
    end
    return { window_id = item.window_id, warning = warning }
  end,
}

rex.action {
  name = "wr_close",
  title = "Close workrex tab",
  args = { session_id = "string", window_id = "string?" },
  run = function(_, args)
    local item = window(args)
    if item then
      call("session.close_window", { session_id = args.session_id, window_id = item.window_id })
    end
    return { closed = true }
  end,
}
