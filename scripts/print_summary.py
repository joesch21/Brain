"""Print a concise overview of The Brain from project_summary.json."""

import json
from pathlib import Path

SUMMARY_PATH = Path(__file__).resolve().parent.parent / "TheBrain" / "project_summary.json"


def load_summary():
    try:
        with SUMMARY_PATH.open("r", encoding="utf-8") as summary_file:
            return json.load(summary_file)
    except FileNotFoundError:
        print(f"Project summary not found at {SUMMARY_PATH}")
    except json.JSONDecodeError as exc:
        print(f"Invalid JSON in project summary: {exc}")
    except Exception as exc:  # noqa: BLE001
        print(f"Could not load project summary: {exc}")
    return None


def print_section(title: str):
    print("\n" + title)
    print("-" * len(title))


def main():
    summary = load_summary()
    if not summary:
        return

    project = summary.get("project", {})
    print_section("Project")
    print(f"Name:   {project.get('name', 'Unknown')}")
    print(f"Status: {project.get('status', 'Unknown')}")
    if project.get("purpose"):
        print(f"Purpose: {project.get('purpose')}")

    flows = summary.get("primary_user_flows", [])
    if flows:
        print_section("Primary Flows")
        for flow in flows:
            print(f"- {flow}")

    backend = summary.get("stack", {}).get("backend", {})
    if backend:
        print_section("Stack")
        print(
            f"Backend: {backend.get('framework', 'Unknown framework')} on {backend.get('language', 'Unknown language')}"
        )
        if backend.get("database"):
            print(f"Database: {backend.get('database')}")
        services = backend.get("services", [])
        if services:
            print("Services:")
            for svc in services:
                print(f"  - {svc}")

    work_orders = summary.get("work_orders", {})
    if work_orders:
        print_section("Work Orders")
        completed = work_orders.get("completed_or_legacy", [])
        planned = work_orders.get("planned_next", [])
        if completed:
            print("Completed/Legacy:")
            for item in completed:
                print(f"  - {item}")
        if planned:
            print("Planned Next:")
            for item in planned:
                print(f"  - {item}")


if __name__ == "__main__":
    main()
