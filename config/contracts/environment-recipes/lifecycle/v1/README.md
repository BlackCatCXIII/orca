# Environment-recipe lifecycle envelope v1

`config/contracts/environment-recipes/lifecycle/v1/schema.json` is the canonical machine-readable contract for the JSON envelope Orca writes to suspend, resume, and destroy recipe stdin. `recipeResult` remains opaque because its result schema is independently versioned; consumers must not treat that nested result as the lifecycle payload itself.

The contract describes runtime source revision `338bd227c12067ace0661d95f66ae4ecb5223a68`. Downstream deployment repositories must vendor `schema.json` byte-for-byte from this directory and verify both its byte count and SHA-256 against `schema.lock.json`; do not regenerate, reformat, or copy only the example shape. Any intentional contract-byte change requires a reviewed lock update, while an incompatible payload shape requires a new version directory.
