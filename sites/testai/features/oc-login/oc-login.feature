@oc-login
Feature: Oc Login

  Scenario: AC1-LOGIN-01 — User logs in with credentials and logs out
    Given I am on the testai login page
    When I enter username "admin" and password "Test123!"
    And I check the Remember Me checkbox
    And I click the Sign In button
    Then I should be logged in
    When I click the user menu
    And I click Sign Out
    Then I should be on the login page
