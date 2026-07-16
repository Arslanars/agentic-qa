@order-flow @destructive
Feature: Order Flow
  As a Moontower user I want to build vendor orders in the tablet POS, send them
  all at once, and then review a sent order in the Orders List — so that I can
  place and audit my restaurant's purchasing in one journey.

  # DESTRUCTIVE: "Send N orders" submits REAL vendor orders that persist in
  # /order-history. Tagged @destructive so the default `npm test`
  # (--grep-invert=@destructive) skips it; run explicitly with
  # `npm run test:destructive` or `--grep @order-flow` (chromium, workers=1,
  # retries=0 — so a retry never double-sends).

  # ---------------------------------------------------------------------
  # ORDER-01 — the full order-send-and-review journey (mirrors the AC verbatim)
  # ---------------------------------------------------------------------

  Scenario: ORDER-01 — send all vendor orders from the tablet POS and review them
    Given I am on the Moontower login page
    When I sign in with email "testing@yopmail.com" and password "12345678"
    Then I should be redirected to the location-picker screen
    When I select the "Main Location" location
    And I click the "Quick Inventory" button
    And I click the "Inventory" button
    And I enable tablet view
    And I click the "Orders" button
    And I click the "Continue to Vendors → (160)" button
    And I click the "Review All Orders →" button
    And I click the "Send 5 orders" button
    Then I should see the confirmation message "Sent 5 orders across 5"
    When I toggle the "GORDON" vendor
    And I click the "Cancel" button
    And I exit tablet view
    And I click the "Orders" button
    And I click the "Orders List" button
    And I view order number 2 in the orders list
    Then I should see "Sprite" in the order details
