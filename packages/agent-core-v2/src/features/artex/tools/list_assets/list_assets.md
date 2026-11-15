Query the asset library: search by a text term, or fetch directly by id/ids; supports pagination. Only returns assets inside the test scope of [this task].
text: a case-insensitive substring matched across the asset's domain, root domain, ip, url, page title, app name, service name and technologies. When neither id nor ids is passed, text must be non-empty (no unconditional full-table queries).
type: optional asset type filter — root_domain|ip|subdomain|app|service|endpoint (stackable with text).
Returns {count, assets}.
