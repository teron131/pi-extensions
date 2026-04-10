# hashline

Overrides Pi's built-in `read` and `edit` tools with a hashline workflow.

## Behavior

- `read` returns text lines as `LINE#ID:content`
- `edit` targets lines by `LINE#ID` anchors instead of exact old-text matching
- image reads still fall back to Pi's built-in `read`

## Why

This reduces brittle exact-match failures by letting the model point at line anchors it just read.
If the file changed, the anchor hash changes too, so edits fail fast with updated references instead of applying against stale text.

## Edit schema

`edit` now expects:

```json
{
  "path": "src/file.ts",
  "edits": [
    {
      "operation": "replace_range",
      "start": "12#ABQ",
      "end": "15#QPT",
      "lines": [
        "const value = 1;",
        "return value;"
      ]
    }
  ]
}
```

Supported `operation` values:

- `replace_line`
- `replace_range`
- `append_at`
- `prepend_at`
- `append_file`
- `prepend_file`

Use `[]` in `lines` to delete a line or range.
Use `[""]` to insert a single blank line.
