Add domains/IPs/CIDRs/ICP registrations/company keywords to a company's [asset scope] — domains, networks, and ICPs automatically claim matching assets; keywords are only provided to the agent as scope hints.
Company names are unique: if the company doesn't exist it is created; if it exists it is reused (the scope is just merged in).
scope is one entry per line; the system auto-recognizes: root domain / URL / single IP / CIDR range / ICP registration / company keyword.
Always give reason explaining the attribution basis (whois/certificates/ASN etc.).
Guardrails: bare TLDs and overly wide ranges are rejected (IPv4 prefixes must be /16-/32, IPv6 prefixes /32-/128); invalid lines are skipped and reported in errors.
