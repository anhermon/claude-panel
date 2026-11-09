// The engine only passes the first TOOL_DESCRIPTION_LIMIT characters of a tool's description to the model and warns on every
// mod reload when it is longer, so a frame type that grows the text must move its shapes into the skill instead.
import { expect, test } from 'claude-code/testing'

import { SCENE_TOOL_DESCRIPTION, TOOL_DESCRIPTION } from '../hooks/spec'

const TOOL_DESCRIPTION_LIMIT = 4096

test('the panel and scene tool descriptions fit in what the engine passes to the model', () => {
  expect(TOOL_DESCRIPTION.length).toBeLessThanOrEqual(TOOL_DESCRIPTION_LIMIT)
  expect(SCENE_TOOL_DESCRIPTION.length).toBeLessThanOrEqual(TOOL_DESCRIPTION_LIMIT)
})
