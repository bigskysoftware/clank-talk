# Fetch

Approved.

`fetch` gets a URL over HTTP. It is the only network access that scripts have.

## Syntax

From hyperscript: `fetch <url> [as <type>] [with <args>]`.

- Approved: `fetch <url>`. The result is the body, as text.
- Approved: `fetch <url> as json` parses the body. `fetch <url> as response` gives `{ status, headers, text }`, and does not fail on a 4xx or 5xx status.
- Approved: `with` takes named values, as a tool call does: `fetch 'https://api.x.com/items' as json with method: 'POST', body: item, headers: { 'X-Key': 1 }`. An object or list as `body` is sent as JSON.
- Approved: `within 10 seconds` sets a time limit. The default is 30 seconds.
- Approved: without `as response`, a status of 400 or more is an error with the status and the start of the body.

## Which hosts

The risk: a fetch can send project data to any host, in the URL or the body. A web page can also hold text that tries to steer the agent (prompt injection).

- Approved: a fetch to a new host asks the human first: `Fetch from api.github.com?` yes or no. A yes holds for the session.
- Approved: `allow fetch from 'api.github.com', 'registry.npmjs.org'` in AGENTS.talk lets those hosts go without asking. `'*.github.com'` allows sub-hosts.
- Approved: only `http` and `https`.
- Approved: `localhost`, and hosts that are IP addresses in private ranges (`127.*`, `10.*`, `192.168.*`, `169.254.*`, ...), are refused unless AGENTS.talk names them. Thus a script cannot reach the cloud metadata service or local admin pages by mistake.
- Approved: a redirect is followed only to a host that is allowed in the same way.
- Limit: the host check uses the name, not the address. A public name that points to a private address (DNS rebinding) is not caught.

## Limits

- Approved: a response body over 5 MB is an error. The default time limit is 30 seconds, and `within` can make it shorter.
- Approved (built): a 303, or a 301 or 302 after a POST, goes on as a GET with no body, as browsers do. At most 5 redirects.
- Approved: the child environment, secrets and cookies are never sent. Headers are only what the script gives.
- Approved: `before fetch` and `after fetch` hooks, with `url`, `method`, and in `after`, `status`.
- Later: taint. Fetched text is untrusted, and taint will track it.
