-- Connect AI for Roblox Studio
-- Install as a local Studio plugin. Set API_URL and API_TOKEN below before using.

local HttpService = game:GetService("HttpService")
local Selection = game:GetService("Selection")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Players = game:GetService("Players")

local API_URL = "https://YOUR-RENDER-SERVICE.onrender.com/api/chat"
local API_TOKEN = "CHANGE_THIS_TO_THE_SAME_SECRET_AS_CONNECT_AI_TOKEN"

local toolbar = plugin:CreateToolbar("Connect AI")
local openButton = toolbar:CreateButton("ConnectAI", "Open Connect AI assistant", "")
openButton.ClickableWhenViewportHidden = true

local widgetInfo = DockWidgetPluginGuiInfo.new(
    Enum.InitialDockState.Right, true, false, 420, 560, 320, 360
)
local widget = plugin:CreateDockWidgetPluginGui("ConnectAI_MainWidget_v1", widgetInfo)
widget.Title = "Connect AI"

local function make(className, props, parent)
    local obj = Instance.new(className)
    for key, value in pairs(props or {}) do obj[key] = value end
    obj.Parent = parent
    return obj
end

local root = make("Frame", {Size = UDim2.fromScale(1, 1), BackgroundColor3 = Color3.fromRGB(22, 24, 31), BorderSizePixel = 0}, widget)
make("UIPadding", {PaddingTop = UDim.new(0, 12), PaddingBottom = UDim.new(0, 12), PaddingLeft = UDim.new(0, 12), PaddingRight = UDim.new(0, 12)}, root)
make("UIListLayout", {FillDirection = Enum.FillDirection.Vertical, SortOrder = Enum.SortOrder.LayoutOrder, Padding = UDim.new(0, 8)}, root)

local header = make("TextLabel", {LayoutOrder = 1, Size = UDim2.new(1, 0, 0, 34), BackgroundTransparency = 1, Font = Enum.Font.GothamBold, Text = "CONNECT AI", TextColor3 = Color3.fromRGB(255, 70, 95), TextSize = 22, TextXAlignment = Enum.TextXAlignment.Left}, root)
local subtitle = make("TextLabel", {LayoutOrder = 2, Size = UDim2.new(1, 0, 0, 28), BackgroundTransparency = 1, Font = Enum.Font.Gotham, Text = "Roblox development assistant · Gemini", TextColor3 = Color3.fromRGB(180, 185, 198), TextSize = 12, TextXAlignment = Enum.TextXAlignment.Left}, root)

local output = make("TextBox", {LayoutOrder = 3, Size = UDim2.new(1, 0, 1, -210), BackgroundColor3 = Color3.fromRGB(30, 33, 43), TextColor3 = Color3.fromRGB(235, 238, 245), PlaceholderText = "Connect AI responses will appear here...", PlaceholderColor3 = Color3.fromRGB(135, 140, 153), Font = Enum.Font.Code, TextSize = 13, TextXAlignment = Enum.TextXAlignment.Left, TextYAlignment = Enum.TextYAlignment.Top, TextWrapped = true, ClearTextOnFocus = false, MultiLine = true, TextEditable = false, Text = "Welcome to Connect AI!\n\nAsk about your game, select a Script and ask for a fix, or request complete Luau systems.\n\nNote: answers are suggestions until you explicitly apply code to a selected script."}, root)
make("UICorner", {CornerRadius = UDim.new(0, 8)}, output)
make("UIPadding", {PaddingTop = UDim.new(0, 8), PaddingBottom = UDim.new(0, 8), PaddingLeft = UDim.new(0, 8), PaddingRight = UDim.new(0, 8)}, output)

local input = make("TextBox", {LayoutOrder = 4, Size = UDim2.new(1, 0, 0, 82), BackgroundColor3 = Color3.fromRGB(30, 33, 43), TextColor3 = Color3.fromRGB(245, 245, 248), PlaceholderText = "Describe what you want built or fixed...", PlaceholderColor3 = Color3.fromRGB(135, 140, 153), Font = Enum.Font.Gotham, TextSize = 13, TextXAlignment = Enum.TextXAlignment.Left, TextYAlignment = Enum.TextYAlignment.Top, TextWrapped = true, ClearTextOnFocus = false, MultiLine = true, Text = ""}, root)
make("UICorner", {CornerRadius = UDim.new(0, 8)}, input)
make("UIPadding", {PaddingTop = UDim.new(0, 8), PaddingBottom = UDim.new(0, 8), PaddingLeft = UDim.new(0, 8), PaddingRight = UDim.new(0, 8)}, input)

local buttons = make("Frame", {LayoutOrder = 5, Size = UDim2.new(1, 0, 0, 36), BackgroundTransparency = 1}, root)
local send = make("TextButton", {Size = UDim2.new(0.49, -4, 1, 0), BackgroundColor3 = Color3.fromRGB(220, 45, 75), TextColor3 = Color3.new(1, 1, 1), Font = Enum.Font.GothamBold, TextSize = 13, Text = "Ask Connect AI"}, buttons)
make("UICorner", {CornerRadius = UDim.new(0, 7)}, send)
local apply = make("TextButton", {Position = UDim2.new(0.51, 4, 0, 0), Size = UDim2.new(0.49, -4, 1, 0), BackgroundColor3 = Color3.fromRGB(55, 115, 85), TextColor3 = Color3.new(1, 1, 1), Font = Enum.Font.GothamBold, TextSize = 13, Text = "Apply code to selected Script"}, buttons)
make("UICorner", {CornerRadius = UDim.new(0, 7)}, apply)

local status = make("TextLabel", {LayoutOrder = 6, Size = UDim2.new(1, 0, 0, 24), BackgroundTransparency = 1, Font = Enum.Font.Gotham, Text = "Ready · Select a Script to include its source", TextColor3 = Color3.fromRGB(160, 170, 185), TextSize = 11, TextXAlignment = Enum.TextXAlignment.Left}, root)

local history = {}
local latestAnswer = ""
local busy = false

local function getSelectedScript()
    local selected = Selection:Get()
    for _, item in ipairs(selected) do
        if item:IsA("LuaSourceContainer") then return item end
    end
    return nil
end

local function safeProperty(instance, propertyName)
    local ok, value = pcall(function() return instance[propertyName] end)
    if not ok then return nil end
    if typeof(value) == "Instance" then return value:GetFullName() end
    if typeof(value) == "Color3" then return string.format("Color3(%.2f, %.2f, %.2f)", value.R, value.G, value.B) end
    if typeof(value) == "Vector3" or typeof(value) == "Vector2" then return tostring(value) end
    if typeof(value) == "UDim2" or typeof(value) == "UDim" then return tostring(value) end
    if typeof(value) == "EnumItem" then return tostring(value) end
    if type(value) == "string" or type(value) == "number" or type(value) == "boolean" then return tostring(value) end
    return nil
end

local function describeInstance(item)
    local lines = {item:GetFullName() .. " [" .. item.ClassName .. "]"}
    local common = {"Name", "Archivable", "Visible", "Enabled", "Active", "Text", "Value", "Size", "Position", "Anchored", "CanCollide", "Transparency", "Color", "Material", "Shape", "WalkSpeed", "JumpPower", "MaxHealth", "Health", "DisplayName", "PrimaryPart"}
    for _, propertyName in ipairs(common) do
        local value = safeProperty(item, propertyName)
        if value ~= nil then table.insert(lines, "  " .. propertyName .. " = " .. value) end
    end
    local attrs = item:GetAttributes()
    for key, value in pairs(attrs) do
        if type(value) == "string" or type(value) == "number" or type(value) == "boolean" then
            table.insert(lines, "  Attribute[" .. key .. "] = " .. tostring(value))
        end
    end
    if item:IsA("Model") then
        local descendants = item:GetDescendants()
        table.insert(lines, "  DescendantCount = " .. tostring(#descendants))
    end
    return table.concat(lines, "\n")
end

local function getPlayerSnapshot()
    local lines = {"Player/session snapshot from the current Studio session (only included when requested):"}
    for _, player in ipairs(Players:GetPlayers()) do
        table.insert(lines, "Player: " .. player.DisplayName .. " (" .. player.Name .. ")")
        local leaderstats = player:FindFirstChild("leaderstats")
        if leaderstats then
            for _, stat in ipairs(leaderstats:GetChildren()) do
                if stat:IsA("ValueBase") then table.insert(lines, "  leaderstats." .. stat.Name .. " = " .. tostring(stat.Value)) end
            end
        end
        local character = player.Character
        local humanoid = character and character:FindFirstChildOfClass("Humanoid")
        if humanoid then
            table.insert(lines, "  Character.Health = " .. tostring(humanoid.Health) .. "/" .. tostring(humanoid.MaxHealth))
            table.insert(lines, "  Character.WalkSpeed = " .. tostring(humanoid.WalkSpeed))
            table.insert(lines, "  Character.JumpPower = " .. tostring(humanoid.JumpPower))
        end
        local backpack = player:FindFirstChildOfClass("Backpack")
        if backpack then
            local tools = {}
            for _, child in ipairs(backpack:GetChildren()) do if child:IsA("Tool") then table.insert(tools, child.Name) end end
            table.insert(lines, "  Backpack.Tools = " .. (#tools > 0 and table.concat(tools, ", ") or "none"))
        end
    end
    return table.concat(lines, "\n")
end

local function getStudioContext(message)
    local chunks = {}
    local selected = Selection:Get()
    if #selected > 0 then
        table.insert(chunks, "Selected instances and common properties:\n" .. table.concat((function()
            local result = {}
            for index, item in ipairs(selected) do
                if index > 20 then table.insert(result, "[Selection truncated at 20 instances]"); break end
                table.insert(result, describeInstance(item))
            end
            return result
        end)(), "\n\n"))
    else
        table.insert(chunks, "No Studio instances are selected.")
    end
    local selectedScript = getSelectedScript()
    if selectedScript then
        local sourceOk, source = pcall(function() return selectedScript.Source end)
        if not sourceOk then source = "[Could not read source. Check plugin permissions and select a Script in Studio.]" end
        if #source > 16000 then source = string.sub(source, 1, 16000) .. "\n-- [source truncated]" end
        table.insert(chunks, "Selected script source: " .. selectedScript:GetFullName() .. " [" .. selectedScript.ClassName .. "]\n```lua\n" .. source .. "\n```")
    end
    local lowerMessage = string.lower(message or "")
    if string.find(lowerMessage, "player", 1, true) or string.find(lowerMessage, "leaderstat", 1, true) or string.find(lowerMessage, "inventory", 1, true) or string.find(lowerMessage, "player experience", 1, true) then
        table.insert(chunks, getPlayerSnapshot())
    end
    return table.concat(chunks, "\n\n")
end

local function cleanCode(text)
    local fenced = string.match(text, "```[lL][uU][aA][uU]?%s*\n(.-)\n```")
        or string.match(text, "```lua%s*\n(.-)\n```")
        or string.match(text, "```%s*\n(.-)\n```")
    return fenced or text
end

local function requestAI()
    if busy then return end
    local message = input.Text:gsub("^%s+", ""):gsub("%s+$", "")
    if message == "" then status.Text = "Type a message first."; return end
    if API_URL:find("YOUR%-RENDER%-SERVICE") then status.Text = "Set API_URL in the plugin script first."; return end
    busy = true
    send.Text = "Thinking..."
    status.Text = "Connecting to Connect AI..."
    local payload = {
        message = message,
        history = history,
        studioContext = getStudioContext(message)
    }
    local ok, result = pcall(function()
        return HttpService:RequestAsync({
            Url = API_URL,
            Method = "POST",
            Headers = { ["Content-Type"] = "application/json", ["x-connect-ai-token"] = API_TOKEN },
            Body = HttpService:JSONEncode(payload)
        })
    end)
    busy = false
    send.Text = "Ask Connect AI"
    if not ok then
        status.Text = "Connection failed. Check API URL and HTTP requests setting."
        output.Text = "Could not contact Connect AI.\n\n" .. tostring(result) .. "\n\nCheck: API_URL, Render service status, API token, and Game Settings > Security > Allow HTTP Requests."
        return
    end
    local decodedOk, decoded = pcall(function() return HttpService:JSONDecode(result.Body) end)
    if not result.Success then
        local err = decodedOk and decoded.error or result.Body
        status.Text = "Server returned an error (" .. tostring(result.StatusCode) .. ")."
        output.Text = tostring(err)
        return
    end
    latestAnswer = decodedOk and tostring(decoded.answer or "") or ""
    if latestAnswer == "" then latestAnswer = "The server returned no answer. Check Render logs." end
    table.insert(history, {role = "user", text = message})
    table.insert(history, {role = "model", text = latestAnswer})
    while #history > 12 do table.remove(history, 1) end
    output.Text = latestAnswer
    status.Text = "Answer ready · Review it before applying code"
end

send.Activated:Connect(requestAI)
input.FocusLost:Connect(function(enterPressed)
    if enterPressed then requestAI() end
end)

apply.Activated:Connect(function()
    local target = getSelectedScript()
    if not target then
        status.Text = "Select a Script, LocalScript, or ModuleScript first."
        return
    end
    if latestAnswer == "" then
        status.Text = "Ask Connect AI for code first."
        return
    end
    local code = cleanCode(latestAnswer)
    local sourceLooksLikeCode = code:find("local ") or code:find("function ") or code:find("game:GetService") or code:find("return ") or code:find("--")
    if not sourceLooksLikeCode then
        status.Text = "No clear code block found. Ask for the complete code in a ```lua code block."
        return
    end
    local confirm = plugin:GetSetting("ConnectAI_ConfirmApply")
    if confirm ~= false then
        -- First click explains that applying replaces the entire selected script.
        plugin:SetSetting("ConnectAI_ConfirmApply", false)
        status.Text = "Click Apply again to REPLACE the selected script source. Undo is available (Ctrl+Z)."
        return
    end
    local ok, err = pcall(function()
        ChangeHistoryService:SetWaypoint("Before Connect AI apply")
        target.Source = code
        ChangeHistoryService:SetWaypoint("After Connect AI apply")
    end)
    if ok then
        plugin:SetSetting("ConnectAI_ConfirmApply", true)
        status.Text = "Applied to " .. target.Name .. " · Test your game carefully"
    else
        status.Text = "Could not edit script: " .. tostring(err)
    end
end)

openButton.Click:Connect(function()
    widget.Enabled = not widget.Enabled
end)
