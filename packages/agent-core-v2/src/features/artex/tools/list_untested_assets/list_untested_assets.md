Query the assets inside the scope of [this task] that haven't been covered by fact anchors yet (it informs your own judgment about supplementary testing — it doesn't decide for you).
Optional filter by asset type: root_domain/subdomain/service/app/endpoint/ip.
Pagination: page starts at 1, page_size defaults to 10. Returns {assets:[{id,type,label}], total, page, page_size}. Only available in a task context.
