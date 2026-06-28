@login
Feature: Login User
  As a registered Moontower user, I want to sign in with my email and password
  so that I can access my restaurant's dashboard.

  Background:
    Given I am on the Moontower login page

  # ---------------------------------------------------------------------
  # POSITIVE — happy path
  # ---------------------------------------------------------------------

  Scenario: AC1-POS-01 — successful login with valid credentials
    When I sign in with email "developers@moontower.com" and password "12345678"
    Then I should be redirected to the location-picker screen
    And I should see the heading "Select Your Location"
    And I should see a paragraph beginning with "Restaurant:"

  # ---------------------------------------------------------------------
  # NEGATIVE — rejected credentials
  # ---------------------------------------------------------------------

  Scenario: AC1-NEG-01 — wrong password is rejected
    When I sign in with email "developers@moontower.com" and password "WrongPassword!2025"
    Then the auth API should return a non-2xx response
    And I should remain on the login page

  Scenario: AC1-NEG-02 — non-existent email is rejected
    When I sign in with a randomly-generated email and password "AnyPass!1234"
    Then the auth API should return a non-2xx response
    And I should remain on the login page

  # ---------------------------------------------------------------------
  # NEGATIVE — required fields
  # ---------------------------------------------------------------------

  Scenario: AC1-NEG-03 — empty email is rejected
    When I sign in with email "" and password "Whatever!2025"
    Then I should not be redirected to the location-picker screen
    And I should remain on the login page

  Scenario: AC1-NEG-04 — empty password is rejected
    When I sign in with email "developers@moontower.com" and password ""
    Then I should not be redirected to the location-picker screen
    And I should remain on the login page

  Scenario: AC1-NEG-05 — both fields empty are rejected
    When I sign in with email "" and password ""
    Then I should not be redirected to the location-picker screen
    And I should remain on the login page

  # ---------------------------------------------------------------------
  # NEGATIVE — format validation (HTML5 validity)
  # ---------------------------------------------------------------------

  Scenario: AC1-NEG-06 — invalid email format (no @) flags typeMismatch
    When I sign in with email "developersmoontower.com" and password "Whatever!2025"
    Then the email field should report a typeMismatch validity error
    And I should not be redirected to the location-picker screen

  Scenario: AC1-NEG-07 — invalid email format (missing domain) flags typeMismatch
    When I sign in with email "developers@" and password "Whatever!2025"
    Then the email field should report a typeMismatch validity error
    And I should not be redirected to the location-picker screen

  # ---------------------------------------------------------------------
  # UI behaviour
  # ---------------------------------------------------------------------

  Scenario: UI-01 — password field is masked by default
    Then the password field input type is "password"

  Scenario: UI-02 — show/hide password button toggles the input type
    When I type "Secret!2025" into the password field
    And I click the "Show password" toggle
    Then the password field input type is "text"
    When I click the "Show password" toggle
    Then the password field input type is "password"

  Scenario: UI-03 — Enter key in the password field submits the form
    When I fill the login form with email "developers@moontower.com" and password "12345678"
    And I press Enter in the password field
    Then I should be redirected to the location-picker screen

  # ---------------------------------------------------------------------
  # Navigation
  # ---------------------------------------------------------------------

  Scenario: NAV-01 — "Forgot password?" link navigates to /forgot-password
    When I click the "Forgot password?" link
    Then the URL should match "/forgot-password$"

  Scenario: NAV-02 — "Sign up" link navigates to /signup
    When I click the "Sign up" link
    Then the URL should match "/signup$"

  Scenario: NAV-03 — "← Back" link navigates to the homepage
    When I click the "← Back" link
    Then the URL should match the homepage
