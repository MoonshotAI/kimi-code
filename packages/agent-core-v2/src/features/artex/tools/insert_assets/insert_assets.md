Register newly discovered assets in bulk; multiple types can be mixed in one call (see the type enum).
Required fields per type: root_domain→domain; ip→ip (must be IPv4/IPv6, not a hostname); subdomain→domain; app→app_name; service(HTTP)→url; service(non-HTTP)→service_name+port (at least one of ip/domain); endpoint→url+method. See each field's own description for the rest.
auth/technologies/params are append-merged, not overwritten.
Returns: {results:[{index,id,type}], errors:[{index,error}]}
