@dashboard
Feature: Verify Dashboard
  As a registered Moontower user, I want to sign in and choose my location
  so that I land on my restaurant's inventory dashboard.

  Background:
    Given I am on the Moontower login page

  # ---------------------------------------------------------------------
  # AC1 — Visit the website and log in with the given credentials
  # ---------------------------------------------------------------------

  Scenario: AC1-POS-01 — valid credentials log in and reach the location picker
    When I log in with the provided Moontower credentials
    Then I should be redirected to the location-picker screen

  # ---------------------------------------------------------------------
  # AC2 — After login the "Select Your Location" prompt is shown
  # ---------------------------------------------------------------------

  Scenario: AC2-POS-01 — the "Select Your Location" prompt is shown after login
    When I log in with the provided Moontower credentials
    Then I should see the heading "Select Your Location"

  # ---------------------------------------------------------------------
  # AC3 — Choosing "Main Location" opens the inventory-vendors dashboard
  # ---------------------------------------------------------------------

  Scenario: AC3-POS-01 — choosing "Main Location" opens the inventory-vendors dashboard
    When I log in with the provided Moontower credentials
    And I choose the "Main Location" option
    Then the dashboard URL should be "https://moontower.aiimone.com/inventory-vendors"
