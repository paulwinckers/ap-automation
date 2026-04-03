"""
Quick script to explore Aspire API data for the Construction dashboard.
Run from the backend directory: python explore_aspire.py
"""
import asyncio
import httpx
import json
import os
from dotenv import load_dotenv

load_dotenv()

BASE_URL    = os.getenv("ASPIRE_BASE_URL", "https://cloud-api.youraspire.com")
TOKEN_URL   = os.getenv("ASPIRE_TOKEN_URL", "https://cloud-api.youraspire.com/token")
CLIENT_ID   = os.getenv("ASPIRE_CLIENT_ID")
CLIENT_SECRET = os.getenv("ASPIRE_CLIENT_SECRET")


async def get_token(client: httpx.AsyncClient) -> str:
    resp = await client.post(
        f"{BASE_URL}/Authorization",
        json={"ClientId": CLIENT_ID, "Secret": CLIENT_SECRET},
    )
    resp.raise_for_status()
    return resp.json()["Token"]


async def get(client: httpx.AsyncClient, token: str, path: str, params: dict = None) -> dict:
    resp = await client.get(
        f"{BASE_URL}/{path.lstrip('/')}",
        params=params,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json;odata.metadata=minimal",
        },
    )
    resp.raise_for_status()
    return resp.json()


async def main():
    async with httpx.AsyncClient(timeout=30.0) as client:
        print("Getting token...")
        token = await get_token(client)
        print("Token OK\n")

        # 1. See all distinct divisions
        print("=== Fetching sample opportunities to see divisions ===")
        result = await get(client, token, "Opportunities", {
            "$select": "OpportunityID,OpportunityName,DivisionName,DivisionID,OpportunityStatusName,JobStatusName",
            "$top": "50",
        })
        opps = result.get("value", result if isinstance(result, list) else [])
        divisions = {}
        for o in opps:
            div = o.get("DivisionName") or "(none)"
            did = o.get("DivisionID")
            divisions[div] = did
        print(f"Divisions found in first 50 records:")
        for name, did in sorted(divisions.items()):
            print(f"  DivisionID={did}  DivisionName='{name}'")

        # 2. Fetch Construction opportunities with financial fields
        print("\n=== Fetching Construction opportunities (2026) ===")
        result2 = await get(client, token, "Opportunities", {
            "$filter": "DivisionName eq 'Construction' and StartDate ge 2026-01-01T00:00:00Z",
            "$select": (
                "OpportunityID,OpportunityName,OpportunityStatusName,JobStatusName,"
                "WonDollars,ActualEarnedRevenue,ActualGrossMarginDollars,ActualGrossMarginPercent,"
                "EstimatedDollars,EstimatedGrossMarginDollars,EstimatedGrossMarginPercent,"
                "PercentComplete,StartDate,EndDate,CompleteDate"
            ),
            "$top": "100",
        })
        opps2 = result2.get("value", result2 if isinstance(result2, list) else [])
        print(f"Found {len(opps2)} Construction opportunities")

        if opps2:
            print("\nSample (first 5):")
            for o in opps2[:5]:
                print(json.dumps(o, indent=2, default=str))

            # Totals
            total_won     = sum((o.get("WonDollars") or 0) for o in opps2)
            total_earned  = sum((o.get("ActualEarnedRevenue") or 0) for o in opps2)
            total_margin  = sum((o.get("ActualGrossMarginDollars") or 0) for o in opps2)
            print(f"\n--- Totals across {len(opps2)} jobs ---")
            print(f"  WonDollars (contracted):       ${total_won:,.0f}")
            print(f"  ActualEarnedRevenue:           ${total_earned:,.0f}")
            print(f"  ActualGrossMarginDollars:      ${total_margin:,.0f}")
        else:
            print("No results — trying without date filter...")
            result3 = await get(client, token, "Opportunities", {
                "$filter": "DivisionName eq 'Construction'",
                "$select": "OpportunityID,OpportunityName,OpportunityStatusName,DivisionName,WonDollars,ActualEarnedRevenue",
                "$top": "10",
            })
            opps3 = result3.get("value", result3 if isinstance(result3, list) else [])
            print(f"Without date filter: {len(opps3)} results")
            for o in opps3[:3]:
                print(json.dumps(o, indent=2, default=str))


asyncio.run(main())
