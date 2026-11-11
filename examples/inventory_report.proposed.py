"""Print a small stock report using the sample items below."""

from __future__ import annotations

# Each row describes one product; prices are in dollars.


LOW_STOCK = 3

ITEMS = [
    {"name": " Notebook ", "quantity": 12, "price": 4.50, "enabled": True},
    {"name": "Pencil", "quantity": 3, "price": 0.75, "enabled": True},
    {"name": "Marker", "quantity": 0, "price": 2.25, "enabled": True},
    {"name": "Old calendar", "quantity": 8, "price": 5.00, "enabled": False},
]


def active_items(items: list[dict]) -> list[dict]:
    return [item for item in items if item["enabled"]]


def inventory_value(items: list[dict]) -> float:
    total = 0.0
    for item in items:
        price = item["price"]
        total += price * item["quantity"]
    return total


def low_stock_items(items: list[dict]) -> list[dict]:
    return [
        item for item in items
        if item["quantity"] <= LOW_STOCK
    ]


def format_row(item: dict) -> str:
    name = item["name"].strip()
    quantity = item["quantity"]
    price = item["price"]
    return f"{name:20s} {quantity:5d} {price:9.2f}"


def print_table(items: list[dict]) -> None:
    print("Item                   Qty     Price")
    print("-" * 38)
    for item in sorted(items, key=lambda row: row["name"].strip()):
        print(format_row(item))


def main() -> None:
    items = active_items(ITEMS)
    print("Office inventory report")
    print_table(items)
    print("Only enabled products appear in this report.")
    print()
    print(f"Total units: {sum(item['quantity'] for item in items)}")
    print(f"Stock value: ${inventory_value(items):.2f}")
    print(f"Low stock (at most {LOW_STOCK} units):")
    for item in low_stock_items(items):
        print(f"- {item['name'].strip()}: {item['quantity']} left")


if __name__ == "__main__":
    main()

# Run this file directly to print the sample report.
