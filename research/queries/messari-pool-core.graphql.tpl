# The pool-level identity core, as a template over the ONE thing the Messari standard
# does not standardize: the root field name.
#
# Substitute __ROOT__ with the vertical's root field and the selection set below is
# accepted unchanged:
#
#   vaults          -> schema-yield                    (ERC-4626 and other vaults)
#   markets         -> schema-lending                  (lending markets)
#   liquidityPools  -> schema-dex-amm                  (AMM pools)
#   liquidityPools  -> schema-derivatives-perpfutures
#   liquidityPools  -> schema-derivatives-options
#   pools           -> schema-generic
#
# Four distinct root names, one selection set, one downstream mapper. That asymmetry is
# also the reason a tool-using agent struggles here: the field NAMES are the part the
# model has to guess per deployment, and guessing `pools` at a dex-amm deployment is a
# validation error, not a smaller answer.
query PoolIdentity($skip: Int!) {
  __ROOT__(first: 1000, skip: $skip, orderBy: totalValueLockedUSD, orderDirection: desc) {
    id
    name
    outputToken { id symbol name decimals }
    totalValueLockedUSD
    createdBlockNumber
    protocol { name slug network type schemaVersion }
  }
  _meta { block { number timestamp } deployment }
}
