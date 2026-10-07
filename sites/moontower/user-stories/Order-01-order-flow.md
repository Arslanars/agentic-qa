# User Story: Order-01 - Order Flow

## Application URL
https://moontower.aiimone.com/login

## Test Credentials
testing@yopmail.com
12345678

## Acceptance Criteria
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
