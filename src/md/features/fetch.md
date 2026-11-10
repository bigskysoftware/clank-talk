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
- Approved (built): the check covers every form of these addresses: a trailing dot (`localhost.`), IPv6 forms that hold an IPv4 address (`::127.0.0.1`, `::ffff:`, NAT64 `64:ff9b::`, 6to4 `2002::`), IPv6 unique local, link-local, site-local and multicast, and the IPv4 ranges `192.0.0.*`, `198.18-19.*`, and `224.*` and above.
- Approved (built): a private host needs its own line in AGENTS.talk, such as `allow fetch from 'localhost'`. A `*.` pattern does not allow it.
- Approved (built): on a redirect to another origin (scheme, host or port), the script's headers stay behind, because they often hold a key for the first host. A 307 or 308 that would send the body to another origin is an error.
- Approved (built): any redirect that keeps the body is an error if it goes to another origin, also a 301 or 302 after a PUT, PATCH or DELETE. Before, only 307 and 308 were checked. Why: the body can hold a secret.
- Approved (built): the audit records each redirect, as its own `redirect` step: the URL, the status, and where it goes (`302 to https://...`). Why: a redirect can send a request to another place, so it is a security risk.
- Approved: a redirect is followed only to a host that is allowed in the same way.
- Approved (built): the runtime also looks up the addresses of a name. If one of them is a local or private address, the fetch is refused, as for a private host. Only a line in AGENTS.talk with that exact name allows it. A name that does not resolve is not refused here: the fetch itself then fails.
- Limit: the connection does its own lookup. Thus a name that changes its answer between the check and the connection (DNS rebinding) is not caught.

## Limits

- Approved: a response body over 5 MB is an error. The default time limit is 30 seconds, and `within` can make it shorter.
- Approved (built): a 303, or a 301 or 302 after a POST, goes on as a GET with no body, as browsers do. At most 5 redirects.
- Approved: the child environment and cookies are never sent. Headers are only what the script gives. A secret goes only as `secret NAME`: see [secrets.md](secrets.md).
- Approved: `before fetch` and `after fetch` hooks, with `url`, `method`, `secrets` (the names of the secrets in the headers and the body), and in `after`, `status`.
- Later: taint. Fetched text is untrusted, and taint will track it.
