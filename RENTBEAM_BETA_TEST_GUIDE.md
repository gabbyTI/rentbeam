# RentBeam Beta Testing Guide

## Welcome Beta Tester! 🎉

Thank you for helping test RentBeam! This guide will walk you through everything step-by-step. **No technical knowledge needed** - just follow along and share your honest feedback.

---

## What is RentBeam?

RentBeam helps landlords collect rent automatically and gives tenants an easy way to pay online. Think of it like Venmo, but specifically for rent payments.

---

## What You'll Be Testing

You'll test **both sides** of the platform:
1. **Landlord side** - Managing properties and collecting rent
2. **Tenant side** - Paying rent and setting up autopay

**Time needed:** 30-45 minutes

---

## Before You Start

### What You'll Need:
- ✅ A computer or phone with internet
- ✅ An email address (you can use a fake one for testing)
- ✅ A test credit card (we'll provide this - **NO real money will be charged**)
- ✅ 30-45 minutes of uninterrupted time

### Test Credit Card (Stripe Test Mode):
```
Card Number: 4242 4242 4242 4242
Expiry: Any future date (e.g., 12/25)
CVC: Any 3 digits (e.g., 123)
ZIP: Any 5 digits (e.g., 12345)
```

**Important:** This is a TEST card. No real money will be charged!

---

## Part 1: Testing as a LANDLORD (20 minutes)

### Step 1: Create Your Landlord Account

1. Go to: **[YOUR_APP_URL]/landlord/signup**
2. Fill in the signup form:
   - **Email:** Use any email (can be fake like `test123@test.com`)
   - **Password:** Create any password (write it down!)
   - **Name:** Your name or "Test Landlord"
3. Click **"Sign Up"**
4. Check your email for verification code (if required)
5. Enter the code and verify

**✍️ Feedback Questions:**
- Was the signup process clear?
- Did anything confuse you?
- How long did this take?

---

### Step 2: Complete Your Profile

1. You should see a welcome screen or profile setup
2. Fill in your information:
   - Business name (optional)
   - Phone number
   - Any other requested info
3. Click **"Continue"** or **"Save"**

**✍️ Feedback Questions:**
- Was it clear what information was required vs optional?
- Did you understand why this information was needed?

---

### Step 3: Connect Stripe (Bank Account Setup)

1. You'll be asked to connect your bank account for payouts
2. Click **"Connect Stripe"** or **"Setup Payouts"**
3. You'll be redirected to Stripe's onboarding
4. **For testing, you can:**
   - Use fake information (this is test mode)
   - Skip this step if there's a "Skip for now" option
5. Return to RentBeam

**✍️ Feedback Questions:**
- Was it clear why you needed to connect a bank account?
- Did the Stripe process feel trustworthy?
- Was it confusing to leave the site and come back?

---

### Step 4: Add Your First Property

1. Look for **"Add Property"** or **"Properties"** button
2. Click it and fill in:
   - **Property Name:** "Sunset Apartments" (or anything)
   - **Address:** "123 Main St, Anytown, USA"
   - **Accept Online Payments:** Leave checked (enabled)
3. Click **"Save"** or **"Create Property"**

**✍️ Feedback Questions:**
- Was it easy to find where to add a property?
- Were the form fields clear?
- Did you understand what "Accept Online Payments" means?

---

### Step 5: Add Units to Your Property

1. Find your property and click **"Add Unit"** or similar
2. Add 2-3 units with different details:

**Unit 1:**
- Name: "Unit 101"
- Rent Amount: $1500
- Due Day: 1 (1st of month)
- Grace Period: 5 days

**Unit 2:**
- Name: "Unit 102"
- Rent Amount: $1200
- Due Day: 15 (15th of month)
- Grace Period: 3 days

3. Save each unit

**✍️ Feedback Questions:**
- Was it clear what each field meant?
- Did you understand "Due Day" and "Grace Period"?
- Could you easily add multiple units?

---

### Step 6: Invite a Tenant

1. Find **"Tenants"** or **"Invite Tenant"** button
2. Click **"Invite Tenant"** or **"Add Tenant"**
3. Fill in tenant information:
   - **Email:** Use a DIFFERENT email than your landlord account (e.g., `tenant123@test.com`)
   - **Name:** "Test Tenant" or any name
   - **Phone:** Any phone number
   - **Unit:** Select "Unit 101"
   - **Move-in Date:** Today's date or recent date
4. Click **"Send Invite"**
5. **IMPORTANT:** Copy the invite link or check the email

**✍️ Feedback Questions:**
- Was the invite process straightforward?
- Did you understand what would happen after sending the invite?
- Was it clear which unit the tenant was being assigned to?

---

### Step 7: Explore the Landlord Dashboard

1. Go to **"Dashboard"** (should be main page)
2. Look around and explore:
   - Can you see your properties?
   - Can you see your tenants?
   - Can you see payment status?
   - Are there any charts or metrics?

**✍️ Feedback Questions:**
- What information is most useful to you?
- What information is missing?
- Is anything confusing or unclear?
- Does the dashboard look professional?

---

### Step 8: Try Recording a Manual Payment

1. Find a tenant who hasn't paid yet
2. Look for **"Mark as Paid"** or **"Record Payment"** button
3. Click it and fill in:
   - Amount: The rent amount
   - Date: Today's date
   - Note: "Paid via Interac e-Transfer"
4. Save the payment

**✍️ Feedback Questions:**
- Was it easy to find how to record a payment?
- Were the fields clear?
- Did the payment show up correctly after saving?

---

## Part 2: Testing as a TENANT (15 minutes)

### Step 9: Accept the Tenant Invite

1. **Log out** of your landlord account (find logout button)
2. Open the invite link you copied earlier (or check the email)
3. You should see an invite acceptance page
4. Review the information shown:
   - Landlord name
   - Property address
   - Unit number
   - Rent amount
   - Due date

**✍️ Feedback Questions:**
- Was all the important information clearly displayed?
- Did you feel confident accepting the invite?
- Was anything missing that you'd want to know?

---

### Step 10: Create Your Tenant Account

1. Click **"Accept Invite"** or **"Create Account"**
2. Set your password
3. Fill in any additional information requested
4. Complete the signup

**✍️ Feedback Questions:**
- Was the tenant signup easier or harder than landlord signup?
- Did you understand the difference between the two account types?

---

### Step 11: Explore the Tenant Dashboard

1. You should now see the tenant dashboard
2. Look around and note:
   - Can you see your rent amount?
   - Can you see when rent is due?
   - Can you see your payment history?
   - Is your payment status clear (paid/unpaid/late)?

**✍️ Feedback Questions:**
- Is the most important information easy to find?
- What would you want to see that's missing?
- Does it feel overwhelming or too simple?

---

### Step 12: Add a Payment Method

1. Look for **"Add Payment Method"** or **"Setup Payment"** button
2. Click it
3. Enter the test card information:
   ```
   Card: 4242 4242 4242 4242
   Expiry: 12/25
   CVC: 123
   ZIP: 12345
   ```
4. Save the payment method

**✍️ Feedback Questions:**
- Did you feel safe entering card information?
- Was it clear this was a test and no real charges would occur?
- Did the process feel secure?

---

### Step 13: Make a One-Time Payment

1. Find **"Pay Now"** or **"Make Payment"** button
2. Click it
3. Review the payment details:
   - Rent amount
   - Processing fee (should show 2.9% + $0.30)
   - Total amount
4. Confirm the payment
5. Wait for confirmation

**✍️ Feedback Questions:**
- Was the fee breakdown clear?
- Did you understand what you were paying?
- Was the confirmation clear?
- How long did the payment take to process?

---

### Step 14: Enable Autopay (Optional)

1. Go to **"Settings"** or look for **"Autopay"** section
2. Find **"Enable Autopay"** toggle or button
3. Turn on autopay
4. Confirm your payment method
5. Review the autopay settings

**✍️ Feedback Questions:**
- Was it clear what autopay does?
- Did you understand when you'd be charged?
- Could you easily disable it if you wanted to?
- Did you feel in control of the autopay feature?

---

### Step 15: Check Payment History

1. Find **"Payment History"** or **"Payments"** section
2. Look at your payment(s)
3. Check if you can see:
   - Payment dates
   - Amounts
   - Payment methods (card vs manual)
   - Status (paid/pending/failed)

**✍️ Feedback Questions:**
- Is the payment history easy to read?
- Is there enough detail?
- Can you easily tell which payments were autopay vs manual?

---

## Part 3: Testing Edge Cases (10 minutes)

### Test 16: Try Breaking Things (Important!)

Try these scenarios and note what happens:

1. **Try to invite a tenant to a unit that already has a tenant**
   - What happens?

2. **Try to delete a property that has units**
   - Are you warned?
   - What happens to the units?

3. **Try to use an invalid email format when inviting a tenant**
   - Does it catch the error?

4. **Try to set a rent amount of $0 or negative**
   - Does it allow it?

5. **Try to access the landlord dashboard while logged in as a tenant**
   - Are you blocked?

6. **Try to go back and forth between landlord and tenant accounts**
   - Does it work smoothly?

**✍️ Feedback Questions:**
- Did anything break or behave unexpectedly?
- Were error messages helpful?
- Did you ever feel lost or stuck?

---

## Part 4: Overall Experience (5 minutes)

### General Feedback Questions:

**Design & Usability:**
1. On a scale of 1-10, how easy was RentBeam to use?
2. Did the design look professional and trustworthy?
3. Was the app responsive on your device (phone/tablet/computer)?
4. Were there any buttons or features you couldn't find?
5. Did anything feel slow or laggy?

**Features:**
6. What feature did you like the most?
7. What feature was most confusing?
8. What's missing that you expected to see?
9. If you were a real landlord, would you use this? Why or why not?
10. If you were a real tenant, would you use this? Why or why not?

**Pricing (Hypothetical):**
11. If this cost $5/month per unit, would that be reasonable?
12. Would you prefer to pay per unit or a flat monthly fee?
13. Would you be willing to pay processing fees as a tenant for the convenience?

**Competition:**
14. Have you used similar apps before? (Venmo, Zelle, other rent apps?)
15. How does RentBeam compare?

**Final Thoughts:**
16. What's the ONE thing that needs to be fixed before launch?
17. What's the ONE thing you loved the most?
18. Would you recommend this to a friend? Why or why not?

---

## How to Submit Your Feedback

### Option 1: Fill Out This Form
[Create a Google Form and insert link here]

### Option 2: Send an Email
Email your feedback to: **[your-email@example.com]**

Include:
- Your name (or "Anonymous")
- Device you tested on (iPhone, Android, Windows PC, Mac, etc.)
- Browser you used (Chrome, Safari, Firefox, etc.)
- Answers to the feedback questions above
- Any screenshots of bugs or confusing parts

### Option 3: Schedule a Call
Book a 15-minute call to walk through your feedback:
**[Insert Calendly link or phone number]**

---

## Bugs & Issues

If you encounter any bugs, please note:
1. **What you were trying to do**
2. **What you expected to happen**
3. **What actually happened**
4. **Screenshot (if possible)**

Example:
> "I tried to add a unit with rent amount $1500, but when I saved it, it showed as $150. Screenshot attached."

---

## Thank You! 🙏

Your feedback is incredibly valuable and will directly shape the final product. As a thank you:

- ✅ You'll get **free lifetime access** when we launch
- ✅ Your name in the "Beta Testers" credits (if you want)
- ✅ Early access to all new features

**Questions?** Contact me anytime:
- Email: [your-email@example.com]
- Phone: [your-phone-number]
- Text: [your-phone-number]

---

## Quick Reference

### Test Credentials Reminder:
**Test Credit Card:**
- Card: 4242 4242 4242 4242
- Expiry: 12/25
- CVC: 123
- ZIP: 12345

**App URL:** [YOUR_APP_URL]

**Estimated Time:** 30-45 minutes

---

## Troubleshooting

**"I can't log in"**
- Make sure you're using the correct email and password
- Check if you need to verify your email first
- Try the "Forgot Password" link

**"The invite link doesn't work"**
- Make sure you're logged out of your landlord account first
- Try copying and pasting the full URL
- Contact me if it still doesn't work

**"Payment failed"**
- Make sure you're using the test card: 4242 4242 4242 4242
- Check that all fields are filled in correctly
- Try refreshing the page and trying again

**"I'm stuck and don't know what to do"**
- That's valuable feedback! Note where you got stuck
- Try clicking around to explore
- Contact me and I'll help you through it

---

**Version:** Beta 1.0  
**Last Updated:** [Current Date]  
**Contact:** [Your Email/Phone]
