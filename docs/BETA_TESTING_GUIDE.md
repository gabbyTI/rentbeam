# RentBeam Beta Testing Guide

Welcome to the RentBeam beta! Thank you for helping us test the platform. This guide will walk you through everything you need to test.

---

## What is RentBeam?

RentBeam is a rent collection platform that helps landlords collect rent online and allows tenants to pay rent with a credit card or enable autopay.

---

## What You're Testing

This is a **beta version** - we expect bugs and issues. Your job is to:
- ✅ Try all the features
- ✅ Report anything that doesn't work
- ✅ Tell us what's confusing
- ✅ Share ideas for improvements

**Don't worry about breaking things - you can't!** This is a test environment.

---

## Getting Started

### Test Credentials

You'll receive:
- **Beta website URL**: https://beta.rentbeam.ca (or similar)
- **Test credit card**: We'll provide a Stripe test card (no real money involved)

### Important Notes

⚠️ **This is NOT real money** - All payments use Stripe's test mode  
⚠️ **Use fake data** - Don't enter real addresses, real tenant info, etc.  
⚠️ **Your feedback matters** - Even small issues are important to report

---

## Testing Scenarios

### Scenario 1: Landlord Onboarding (15 minutes)

**Goal:** Set up a landlord account and add your first property

**Steps:**
1. Go to the beta website
2. Click **"Sign Up as Landlord"**
3. Fill out the form:
   - Name: Your real name (or fake)
   - Email: Your real email (you'll need to verify it)
   - Phone: Use any format you want
   - Password: Make it strong
4. Check your email for verification code
5. Enter the verification code
6. Complete Stripe Connect onboarding:
   - This connects your bank account (use test mode, no real bank)
   - Fill out the form (use fake business details)
7. Add your first property:
   - Property name: "Test Building 1"
   - Address: Use any fake address
   - Click "Add Property"
8. Add a unit to your property:
   - Unit name: "Unit 101"
   - Rent amount: $1500
   - Due date: 1st of month
   - Click "Add Unit"

**What to look for:**
- ❓ Was the signup process clear?
- ❓ Did you receive emails promptly?
- ❓ Was Stripe Connect confusing?
- ❓ Could you easily add properties and units?
- ❓ Any errors or bugs?

---

### Scenario 2: Invite a Tenant (5 minutes)

**Goal:** Invite a tenant to your property

**Steps:**
1. From landlord dashboard, click **"Tenants"** or **"Properties"**
2. Find your unit (Unit 101)
3. Click **"Invite Tenant"**
4. Enter tenant details:
   - Email: Use your own email or a friend's
   - Name: "Test Tenant"
   - Select the unit: Unit 101
   - Move-in date: Today's date
5. Click **"Send Invite"**
6. Check the email inbox - you should receive an invite

**What to look for:**
- ❓ Was it easy to find where to invite tenants?
- ❓ Did the invite email arrive quickly?
- ❓ Is the invite email well-designed?
- ❓ Any errors?

---

### Scenario 3: Tenant Accepts Invite (10 minutes)

**Goal:** Accept the landlord's invitation as a tenant

**Steps:**
1. Open the tenant invite email
2. Click **"Accept Invite"**
3. Fill out registration:
   - Name: "Test Tenant"
   - Email: (auto-filled from invite)
   - Phone: Any format
   - Password: Make it strong
4. Verify your email with the code sent
5. You should land on the tenant dashboard
6. Look at your dashboard - you should see:
   - Rent amount due
   - Due date
   - Property/unit info

**What to look for:**
- ❓ Was the invite acceptance smooth?
- ❓ Is the dashboard clear and easy to understand?
- ❓ Is any information missing or confusing?
- ❓ Any errors?

---

### Scenario 4: Set Up Payment Method (5 minutes)

**Goal:** Add a credit card for rent payments

**Steps:**
1. From tenant dashboard, click **"Setup Payment Method"** or **"Pay Rent"**
2. Enter test card details:
   - Card number: `4242 4242 4242 4242`
   - Expiry: Any future date (e.g., 12/30)
   - CVC: Any 3 digits (e.g., 123)
   - ZIP: Any 5 digits (e.g., 12345)
3. Click **"Save Card"**
4. You should see confirmation that your card was saved

**What to look for:**
- ❓ Was it clear where to add a payment method?
- ❓ Did the card save successfully?
- ❓ Did you receive a confirmation email?
- ❓ Any errors?

---

### Scenario 5: Pay Rent Manually (5 minutes)

**Goal:** Make a one-time rent payment

**Steps:**
1. From tenant dashboard, click **"Pay Now"**
2. Review payment details:
   - Rent amount: $1500
   - Processing fee: ~$43.80 (2.9% + $0.30)
   - Total: ~$1543.80
3. Confirm the payment
4. Wait for confirmation
5. Check your email for payment receipt

**What to look for:**
- ❓ Was the payment amount clear?
- ❓ Were the fees transparent?
- ❓ Did the payment process quickly?
- ❓ Did you receive a receipt email?
- ❓ Any errors?

---

### Scenario 6: Check Landlord Dashboard After Payment (5 minutes)

**Goal:** Verify landlord sees the payment

**Steps:**
1. Log back in as the landlord
2. Go to dashboard
3. You should see:
   - Updated payment status (Paid)
   - Payment in recent activity
   - Updated collection rate
4. Click on the payment to see details

**What to look for:**
- ❓ Did the payment show up immediately?
- ❓ Is the payment information accurate?
- ❓ Is the dashboard easy to understand?
- ❓ Can you see transaction fees?
- ❓ Any missing information?

---

### Scenario 7: Enable Autopay (5 minutes)

**Goal:** Set up automatic monthly rent payments

**Steps:**
1. Log in as tenant
2. Go to **"Autopay Settings"** or **"Payment Settings"**
3. Toggle autopay **ON**
4. Confirm the autopay setup
5. You should see autopay is enabled

**What to look for:**
- ❓ Was it clear how to enable autopay?
- ❓ Is it obvious when autopay will charge you?
- ❓ Can you easily disable autopay?
- ❓ Did you get a confirmation email?
- ❓ Any concerns about autopay?

---

### Scenario 8: Mark Manual Payment (Landlord) (5 minutes)

**Goal:** Record a cash/check payment in the system

**Steps:**
1. Log in as landlord
2. Create a new tenant or use existing one
3. Go to **"Payments"** or tenant details
4. Click **"Record Manual Payment"**
5. Enter:
   - Amount: $1500
   - Payment method: Cash (or check/Interac)
   - Date: Today
6. Save the payment
7. Verify it shows in payment history

**What to look for:**
- ❓ Was it easy to find?
- ❓ Can you record different payment types?
- ❓ Does it show correctly in history?
- ❓ Any errors?

---

### Scenario 9: Update Account Settings (5 minutes)

**Goal:** Test updating profile information

**As Tenant:**
1. Go to **"Settings"** or **"Profile"**
2. Try changing:
   - Phone number
   - Password
   - Email (if available)
3. Save changes
4. Log out and log back in to verify

**As Landlord:**
1. Go to **"Settings"**
2. Try updating:
   - Name
   - Phone
   - Notification email
3. Check Stripe account connection

**What to look for:**
- ❓ Were changes saved successfully?
- ❓ Is the settings page intuitive?
- ❓ Any errors?

---

### Scenario 10: Mobile Testing (10 minutes)

**Goal:** Test the app on your phone

**Steps:**
1. Open the beta website on your phone browser
2. Try logging in as both landlord and tenant
3. Test key actions:
   - View dashboard
   - Make a payment (as tenant)
   - View payment history
   - Navigate between pages

**What to look for:**
- ❓ Is the mobile design responsive?
- ❓ Are buttons easy to tap?
- ❓ Is text readable?
- ❓ Any layout issues?
- ❓ Does everything work on mobile?

---

## Additional Things to Try

### Edge Cases (If You Have Time)

1. **Try to break things:**
   - Enter invalid data in forms
   - Use special characters in names
   - Try very long property names
   - Submit forms without filling required fields

2. **Test error handling:**
   - Use wrong password when logging in
   - Try to pay with insufficient funds (use card `4000000000009995`)
   - Try to invite same tenant twice

3. **Test navigation:**
   - Use browser back button
   - Refresh pages
   - Open multiple tabs
   - Try bookmarking pages

4. **Test with multiple properties:**
   - Add 2-3 properties
   - Add multiple units per property
   - Invite tenants to different units
   - See if dashboard handles multiple properties well

---

## How to Report Issues

### Bug Report Template

When you find a bug, send us an email with:

```
BUG REPORT

What were you doing?
[Describe the action you took]

What did you expect to happen?
[What should have happened]

What actually happened?
[What went wrong]

Steps to reproduce:
1. [Step 1]
2. [Step 2]
3. [Step 3]

Browser: [Chrome/Firefox/Safari]
Device: [iPhone/Android/Desktop]
Screenshot: [Attach if possible]
```

**Example:**
```
BUG REPORT

What were you doing?
Trying to add a new property from the landlord dashboard

What did you expect to happen?
Property should be added and show in my property list

What actually happened?
Got an error message "Failed to add property" and nothing happened

Steps to reproduce:
1. Log in as landlord
2. Click "Add Property"
3. Fill out form with name "Test Building"
4. Click Save
5. Error appears

Browser: Chrome
Device: MacBook Pro
Screenshot: Attached
```

---

## Feedback Questions

After testing, please answer these questions:

### Overall Experience
1. Was the app easy to use? (1-10 scale)
2. What was the most confusing part?
3. What did you like most?
4. What frustrated you?

### Landlord Features
5. Is the landlord dashboard helpful?
6. Is inviting tenants straightforward?
7. Is payment tracking clear?
8. What's missing for landlords?

### Tenant Features
9. Is the tenant dashboard clear?
10. Is setting up payments easy?
11. Would you use autopay? Why or why not?
12. What's missing for tenants?

### Design & Usability
13. Is the design professional?
14. Are colors/fonts readable?
15. Is navigation intuitive?
16. Mobile experience good?

### Trust & Security
17. Do you trust entering payment info?
18. Is it clear that payments are secure?
19. Any security concerns?

### Features
20. What features are you surprised are missing?
21. What would you add first?
22. What would you remove?

---

## Sending Your Feedback

**Email your feedback to:** [your-email]@rentbeam.ca

**Include:**
- ✅ Your name
- ✅ Which role you tested (landlord/tenant/both)
- ✅ Devices you tested on
- ✅ All bug reports
- ✅ Answers to feedback questions
- ✅ Screenshots (if you have any)
- ✅ Any other thoughts

---

## Test Timeline

**Suggested testing schedule:**
- **Day 1:** Scenarios 1-5 (landlord + tenant basics)
- **Day 2:** Scenarios 6-8 (payments + autopay)
- **Day 3:** Scenarios 9-10 (settings + mobile)
- **Day 4:** Additional testing + feedback writeup

**Total time needed:** 2-3 hours spread over a few days

---

## Frequently Asked Questions

**Q: Can I use real money?**  
A: No! This is test mode only. Use test cards provided.

**Q: What if I forget my password?**  
A: Use the "Forgot Password" link on login page.

**Q: Can I invite real tenants?**  
A: No, only test with friends/family who know this is beta.

**Q: The site is slow, is that normal?**  
A: Report it! We need to know about performance issues.

**Q: I found a security issue, what do I do?**  
A: Email us immediately with details (mark email as URGENT).

**Q: Can I test payment failures?**  
A: Yes! Use these test cards:
- Success: `4242 4242 4242 4242`
- Decline: `4000 0000 0000 9995`
- Insufficient funds: `4000 0000 0000 9995`

**Q: How often should I test?**  
A: Test whenever convenient, but try to complete all scenarios within a week.

---

## Test Cards Reference

Use these for testing different scenarios:

| Card Number | Result |
|-------------|--------|
| 4242 4242 4242 4242 | ✅ Success |
| 4000 0000 0000 9995 | ❌ Insufficient funds |
| 4000 0000 0000 0002 | ❌ Card declined |
| 4000 0000 0000 9987 | ❌ Lost card |

**For all cards:**
- CVC: Any 3 digits
- Expiry: Any future date
- ZIP: Any 5 digits

---

## Thank You! 🎉

Your feedback is invaluable to making RentBeam better. We appreciate you taking the time to test the platform thoroughly.

**Questions during testing?**  
Email: [your-email]@rentbeam.ca  
Response time: Within 24 hours

**After testing:**  
We'll send you a thank-you gift card for your time! 🎁

---

*Last Updated: January 8, 2026*  
*Beta Version: 1.0*
