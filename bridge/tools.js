// MCP tool definitions. Names mirror chrome-devtools-mcp where possible.
// pageId === Chrome tab ID (see list_pages).

const p = (pageIdRequired = true) => ({
  type: 'object',
  properties: { pageId: { type: 'number', description: 'Chrome tab ID from list_pages' } },
  required: pageIdRequired ? ['pageId'] : [],
  additionalProperties: true,
});

const withProps = (extra = {}, required = []) => {
  const s = p(!required.includes('__nopage__'));
  s.properties = { ...s.properties, ...extra };
  s.required = [...(s.required || []), ...required];
  return s;
};

const uid = { type: 'string', description: 'Element uid from take_snapshot' };
const includeSnapshot = { type: 'boolean', description: 'Include a fresh snapshot in the response' };
const filePath = { type: 'string', description: 'Path to write the output file to' };

export const TOOLS = [
  {
    name: 'list_pages',
    description: 'List all open browser tabs. pageId = tab id.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'new_page',
    description: 'Open a new tab and load a URL.',
    inputSchema: withProps({
      url: { type: 'string' },
      background: { type: 'boolean', description: 'Open in background' },
      isolatedContext: { type: 'string', description: 'If set, opens an incognito window (isolated cookies/storage)' },
    }, ['__nopage__']),
  },
  {
    name: 'close_page',
    description: 'Close a tab.',
    inputSchema: withProps({}),
  },
  {
    name: 'select_page',
    description: 'Bring a tab to front and select it.',
    inputSchema: withProps({ bringToFront: { type: 'boolean' } }),
  },
  {
    name: 'navigate_page',
    description: 'Navigate: url | back | forward | reload.',
    inputSchema: withProps({
      type: { type: 'string', enum: ['url', 'back', 'forward', 'reload'] },
      url: { type: 'string' },
      ignoreCache: { type: 'boolean' },
    }),
  },
  {
    name: 'resize_page',
    description: 'Resize the window containing the tab.',
    inputSchema: withProps({ width: { type: 'number' }, height: { type: 'number' } }, ['width', 'height']),
  },
  {
    name: 'take_snapshot',
    description: 'Text snapshot of the page (a11y-like). Element uids come from here. Prefer over screenshot.',
    inputSchema: withProps({ verbose: { type: 'boolean', description: 'Full accessibility tree via CDP (attaches debugger)' } }),
  },
  {
    name: 'take_screenshot',
    description: 'Screenshot of viewport, full page, or one element.',
    inputSchema: withProps({
      format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
      quality: { type: 'number' },
      uid, fullPage: { type: 'boolean' }, filePath,
    }),
  },
  {
    name: 'evaluate_script',
    description: 'Run a JS function in the page. Args may be element uids.',
    inputSchema: withProps({
      function: { type: 'string', description: 'JS function declaration, e.g. () => document.title' },
      args: { type: 'array', items: { type: 'string' }, description: 'Element uids to pass as arguments' },
      dialogAction: { type: 'string', description: '"accept", "dismiss", or prompt text to auto-handle dialogs' },
      filePath,
    }, ['function']),
  },
  {
    name: 'click',
    description: 'Click an element (dblClick for double click).',
    inputSchema: withProps({ uid, dblClick: { type: 'boolean' }, includeSnapshot }, ['uid']),
  },
  {
    name: 'hover',
    description: 'Hover over an element.',
    inputSchema: withProps({ uid, includeSnapshot }, ['uid']),
  },
  {
    name: 'drag',
    description: 'Drag one element onto another.',
    inputSchema: withProps({ from_uid: uid, to_uid: uid, includeSnapshot }, ['from_uid', 'to_uid']),
  },
  {
    name: 'fill',
    description: 'Fill input/textarea/select/checkbox/radio.',
    inputSchema: withProps({ uid, value: { type: 'string' }, includeSnapshot }, ['uid', 'value']),
  },
  {
    name: 'fill_form',
    description: 'Fill multiple form elements at once.',
    inputSchema: withProps({
      elements: {
        type: 'array',
        items: { type: 'object', properties: { uid: { type: 'string' }, value: { type: 'string' } }, required: ['uid', 'value'] },
      },
      includeSnapshot,
    }, ['elements']),
  },
  {
    name: 'type_text',
    description: 'Type text into the focused element.',
    inputSchema: withProps({ text: { type: 'string' }, submitKey: { type: 'string', description: 'Key to press after typing, e.g. Enter' } }, ['text']),
  },
  {
    name: 'press_key',
    description: 'Press a key or combo, e.g. "Enter", "Control+A". Uses trusted CDP input when debugger attached.',
    inputSchema: withProps({ key: { type: 'string' } }, ['key']),
  },
  {
    name: 'upload_file',
    description: 'Set files on a file input (paths local to the browser machine).',
    inputSchema: withProps({ uid, filePaths: { type: 'array', items: { type: 'string' } } }, ['uid', 'filePaths']),
  },
  {
    name: 'handle_dialog',
    description: 'Accept/dismiss an open JS dialog (requires debugger attached before the dialog opens).',
    inputSchema: withProps({ action: { type: 'string', enum: ['accept', 'dismiss'] }, promptText: { type: 'string' } }, ['action']),
  },
  {
    name: 'wait_for',
    description: 'Wait until any of the given texts appears, or all of textGone disappear, or a fixed time elapses.',
    inputSchema: withProps({
      text: { type: 'array', items: { type: 'string' } },
      textGone: { type: 'array', items: { type: 'string' } },
      time: { type: 'number', description: 'Fixed wait in ms' },
      timeout: { type: 'integer' },
    }),
  },
  {
    name: 'list_network_requests',
    description: 'List recorded network requests (attaches debugger; cleared on navigation).',
    inputSchema: withProps({
      pageSize: { type: 'integer' }, pageIdx: { type: 'integer' },
      resourceTypes: { type: 'array', items: { type: 'string' } },
    }),
  },
  {
    name: 'get_network_request',
    description: 'Full detail of one request incl. response body.',
    inputSchema: withProps({ reqid: { type: 'number' }, requestFilePath: filePath, responseFilePath: filePath }),
  },
  {
    name: 'list_console_messages',
    description: 'List console messages since attach/last navigation.',
    inputSchema: withProps({
      pageSize: { type: 'integer' }, pageIdx: { type: 'integer' },
      types: { type: 'array', items: { type: 'string' } },
    }),
  },
  {
    name: 'get_console_message',
    description: 'Get one console message by msgid.',
    inputSchema: withProps({ msgid: { type: 'number' } }, ['msgid']),
  },
  {
    name: 'emulate',
    description: 'Emulate network/CPU/geolocation/UA/color scheme/viewport/extra headers.',
    inputSchema: withProps({
      networkConditions: { type: 'string', enum: ['Offline', 'Slow 3G', 'Fast 3G', 'Slow 4G', 'Fast 4G'] },
      cpuThrottlingRate: { type: 'number' },
      geolocation: { type: 'string', description: '"lat,lon"; empty clears' },
      userAgent: { type: 'string', description: 'empty clears' },
      colorScheme: { type: 'string', enum: ['dark', 'light', 'auto'] },
      viewport: { type: 'string', description: "'<w>x<h>x<dpr>[,mobile][,touch][,landscape]'" },
      extraHttpHeaders: { type: 'string', description: 'JSON string; empty clears' },
    }),
  },
  {
    name: 'performance_start_trace',
    description: 'Start a performance trace (CDP Tracing). Optionally reloads the page.',
    inputSchema: withProps({ reload: { type: 'boolean' } }),
  },
  {
    name: 'performance_stop_trace',
    description: 'Stop the active trace; returns metrics summary and writes trace JSON.',
    inputSchema: withProps({ filePath }),
  },
  {
    name: 'detach_debugger',
    description: 'Detach the CDP debugger from a tab (removes the debugging banner; clears collectors).',
    inputSchema: withProps({}),
  },
  {
    name: 'scroll',
    description: 'Scroll the page: to an element uid, top/bottom, or by dx/dy.',
    inputSchema: withProps({
      uid, to: { type: 'string', enum: ['top', 'bottom'] },
      dx: { type: 'number' }, dy: { type: 'number' }, includeSnapshot,
    }),
  },
  {
    name: 'get_cookies',
    description: 'Get cookies for the page\'s current URL (optionally one cookie by name).',
    inputSchema: withProps({ name: { type: 'string' } }),
  },
  {
    name: 'set_cookie',
    description: 'Set a cookie on the page\'s current URL.',
    inputSchema: withProps({
      name: { type: 'string' }, value: { type: 'string' },
      path: { type: 'string' }, domain: { type: 'string' },
      secure: { type: 'boolean' }, httpOnly: { type: 'boolean' },
      sameSite: { type: 'string', enum: ['no_restriction', 'lax', 'strict', 'unspecified'] },
      expirationDate: { type: 'number', description: 'Unix epoch seconds' },
    }, ['name', 'value']),
  },
  {
    name: 'remove_cookie',
    description: 'Delete a cookie by name on the page\'s current URL.',
    inputSchema: withProps({ name: { type: 'string' } }, ['name']),
  },
  {
    name: 'list_downloads',
    description: 'List recent browser downloads.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'number' },
        limit: { type: 'integer' },
        state: { type: 'string', enum: ['in_progress', 'interrupted', 'complete'] },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'extract_text',
    description: 'Extract readable text content of the page (or a CSS selector scope). Includes iframe sections.',
    inputSchema: withProps({ selector: { type: 'string' } }),
  },
  {
    name: 'click_xy',
    description: 'Click at viewport coordinates — for canvas/maps/SVG where no element uid exists. Prefer click+uid.',
    inputSchema: withProps({ x: { type: 'number' }, y: { type: 'number' }, dblClick: { type: 'boolean' } }, ['x', 'y']),
  },
  {
    name: 'http_request',
    description: 'Send an HTTP request from the extension (carries the browser session cookies, bypasses page CORS).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string' },
        headers: { type: 'object' },
        body: { type: 'string' },
        timeout: { type: 'integer', description: 'ms, default 30000' },
        filePath: { type: 'string', description: 'Write the response body (binary-safe) to this path' },
      },
      required: ['url'],
      additionalProperties: true,
    },
  },
  {
    name: 'download_file',
    description: 'Download a URL into the browser Downloads dir via chrome.downloads; waits for completion.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        filename: { type: 'string', description: 'Filename (subdirs allowed) relative to Downloads' },
        conflictAction: { type: 'string', enum: ['uniquify', 'overwrite', 'prompt'] },
      },
      required: ['url'],
      additionalProperties: true,
    },
  },
  {
    name: 'save_pdf',
    description: 'Print the page to PDF (CDP Page.printToPDF; attaches debugger).',
    inputSchema: withProps({
      filePath, landscape: { type: 'boolean' },
      scale: { type: 'number' }, printBackground: { type: 'boolean' },
    }),
  },
];
