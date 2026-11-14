#!/usr/bin/env bash
# Full testnet showcase: the seller publishes and exits; four scripted buyers act independently.
set -uo pipefail
cd "$(dirname "$0")/../client"
P=${SD_PREFIX:?set SD_PREFIX}; HASH=${SD_CODE_HASH:-ADKfksXSef9h37xY3WBRZk2CPBmpZLokTEeQHiFuB28}
O=out/showcase; mkdir -p $O
echo "== seller publishes the offer, then its process exits"
pnpm -s tsx bin/seller.ts publish --seller seller-$P.testnet --code-hash $HASH --deadline-a 150 --deadline-b 150 --out $O/offer.json | tee $O/1-publish.log
echo "seller process exit code: ${PIPESTATUS[0]}; no seller process is running from here on" | tee -a $O/1-publish.log
echo "== buyers act independently (separate processes, no shared channel besides the offer file and the chain)"
pnpm -s tsx bin/buyer.ts run --profile ada --account ada-$P.testnet --offer $O/offer.json --no-wait > $O/2-ada.log 2>&1 &
pnpm -s tsx bin/buyer.ts run --profile bo  --account bo-$P.testnet  --offer $O/offer.json --no-wait > $O/2-bo.log 2>&1 &
pnpm -s tsx bin/buyer.ts run --profile cy  --account cy-$P.testnet  --offer $O/offer.json --no-wait > $O/2-cy.log 2>&1 &
pnpm -s tsx bin/buyer.ts run --profile dee --account dee-$P.testnet --offer $O/offer.json > $O/2-dee.log 2>&1 &
wait
for b in ada bo cy dee; do echo "---- $b"; cat $O/2-$b.log; done
echo "== Ada redeems; the seller comes back to deliver"
pnpm -s tsx bin/buyer.ts redeem --account ada-$P.testnet --offer $O/offer.json --tier 0 --units 4 --note "4 seats for Ada's team" | tee $O/3-redeem.log
pnpm -s tsx bin/seller.ts fulfil --offer $O/offer.json | tee $O/4-fulfil.log
for f in out/passes/*.json; do :; done
PASS=$(ls -t out/passes/*.json | head -1)
pnpm -s tsx bin/verify-pass.ts $PASS | tee $O/5-verify.log
