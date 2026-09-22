@oc-login
Feature: Oc Login

  Scenario: AC1-01 — User logs in with remember me and signs out
    When the user closes the initial overlay
    And the user logs in as "admin" with password "Test123!" with remember me checked
    And the user selects the user "Salman"
    And the user signs out
    Then the login page should match its visual baseline
