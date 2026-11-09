// The frame registry: every type is imported statically (a data-driven import() of an unknown type would 404 and
// log a console error). An unknown type falls back to `unsupported`.
import * as ask from './ask.js';
import * as avatar from './avatar.js';
import * as bars from './bars.js';
import * as checks from './checks.js';
import * as compare from './compare.js';
import * as diagram from './diagram.js';
import * as doing from './doing.js';
import * as hints from './hints.js';
import * as html from './html.js';
import * as image from './image.js';
import * as kindstack from './kindstack.js';
import * as lanes from './lanes.js';
import * as line from './line.js';
import * as metric from './metric.js';
import * as now from './now.js';
import * as pulse from './pulse.js';
import * as repeats from './repeats.js';
import * as rings from './rings.js';
import * as sinks from './sinks.js';
import * as steps from './steps.js';
import * as swimlane from './swimlane.js';
import * as text from './text.js';
import * as tickets from './tickets.js';
import * as timeline from './timeline.js';
import * as uml from './uml.js';
import * as viz from './viz.js';
import * as unsupported from './unsupported.js';

export const FRAME_TYPES = { ask, avatar, bars, checks, compare, diagram, doing, hints, html, image, kindstack, lanes, line, metric, now, pulse, repeats, rings, sinks, steps, swimlane, text, tickets, timeline, uml, viz };
export const frameModule = (type) => (Object.hasOwn(FRAME_TYPES, type) ? FRAME_TYPES[type] : unsupported);
