# 飞书渠道配置教程（可复制）

## 回调地址

- `https://{{kairoHost}}/api/channels/feishu/webhook`

## 事件订阅

- `im.chat.access_event.bot_p2p_chat_entered_v1`（v2.0）
- `im.message.receive_v1`（v2.0）
- `p2p_chat_create`（v1.0）

## 环境变量

```bash
KAIRO_FEISHU_ENABLED=true
KAIRO_FEISHU_APP_ID=cli_xxx
KAIRO_FEISHU_APP_SECRET=xxx
KAIRO_FEISHU_WEBHOOK_PATH=/api/channels/feishu/webhook
KAIRO_FEISHU_AGENT_ID=default
KAIRO_FEISHU_INBOX_DIR=workspace/feishu-inbox
KAIRO_FEISHU_MAX_UPLOAD_BYTES=31457280
KAIRO_FEISHU_VERIFICATION_TOKEN=your_verification_token
KAIRO_FEISHU_ENCRYPT_KEY=your_encrypt_key
```

## 权限配置（完整可导入）

```json
{
  "scopes": {
    "tenant": [
      "application:application:self_manage",
      "cardkit:card:read",
      "cardkit:card:write",
      "contact:contact.base:readonly",
      "docx:document:readonly",
      "im:chat:read",
      "im:chat:update",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message.pins:read",
      "im:message.pins:write_only",
      "im:message.reactions:read",
      "im:message.reactions:write_only",
      "im:message:readonly",
      "im:message:recall",
      "im:message:send_as_bot",
      "im:message:send_multi_users",
      "im:message:send_sys_msg",
      "im:message:update",
      "im:resource"
    ],
    "user": [
      "base:app:copy",
      "base:app:create",
      "base:app:read",
      "base:app:update",
      "base:field:create",
      "base:field:delete",
      "base:field:read",
      "base:field:update",
      "base:record:create",
      "base:record:delete",
      "base:record:retrieve",
      "base:record:update",
      "base:table:create",
      "base:table:delete",
      "base:table:read",
      "base:table:update",
      "base:view:read",
      "base:view:write_only",
      "board:whiteboard:node:create",
      "board:whiteboard:node:read",
      "calendar:calendar.event:create",
      "calendar:calendar.event:delete",
      "calendar:calendar.event:read",
      "calendar:calendar.event:reply",
      "calendar:calendar.event:update",
      "calendar:calendar.free_busy:read",
      "calendar:calendar:read",
      "contact:contact.base:readonly",
      "contact:user.base:readonly",
      "contact:user.employee_id:readonly",
      "contact:user:search",
      "docs:document.comment:create",
      "docs:document.comment:read",
      "docs:document.comment:update",
      "docs:document.media:download",
      "docs:document:copy",
      "docx:document:create",
      "docx:document:readonly",
      "docx:document:write_only",
      "drive:drive.metadata:readonly",
      "drive:file:download",
      "drive:file:upload",
      "im:chat.members:read",
      "im:chat:read",
      "im:message",
      "im:message.group_msg:get_as_user",
      "im:message.p2p_msg:get_as_user",
      "im:message:readonly",
      "offline_access",
      "search:docs:read",
      "search:message",
      "space:document:delete",
      "space:document:move",
      "space:document:retrieve",
      "task:comment:read",
      "task:comment:write",
      "task:task:read",
      "task:task:write",
      "task:task:writeonly",
      "task:tasklist:read",
      "task:tasklist:write",
      "wiki:node:copy",
      "wiki:node:create",
      "wiki:node:move",
      "wiki:node:read",
      "wiki:node:retrieve",
      "wiki:space:read",
      "wiki:space:retrieve",
      "wiki:space:write_only"
    ]
  }
}
```
