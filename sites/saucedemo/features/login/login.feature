@sauce-login
Feature: Sauce Demo sign-in

  Scenario: SAUCE-001-POS-01 — a standard user reaches the product list
    Given I am on the Sauce Demo login page
    When I sign in as "standard_user"
    Then I should land on the product list

  Scenario: SAUCE-001-NEG-01 — a locked-out user is rejected
    Given I am on the Sauce Demo login page
    When I sign in as "locked_out_user"
    Then I should see the error "Epic sadface: Sorry, this user has been locked out."
