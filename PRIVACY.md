# Privacy Policy for ModHeader Lite

**Last Updated:** [Insert Date, e.g., July 15, 2026]

This privacy policy governs your use of the **ModHeader Lite** Chrome extension (the "Extension"). 

We believe in complete transparency and absolute privacy. Because of this, the Extension is designed to operate entirely on your local machine without collecting, storing, or transmitting any of your personal data.

### 1. Data Collection and Usage
* **No Personal Data Collected:** We do not collect, store, or share any personal information, browsing history, IP addresses, or network data.
* **No External Communication:** The Extension does not communicate with any external servers, APIs, or database backends. All operations are processed locally within your browser's runtime environment.
* **Local Storage:** Any configurations you set (such as custom header names, values, and active/inactive toggle states) are stored exclusively in your browser's local storage profile using the Chrome Storage API. This data is kept on your device and is never uploaded to the cloud or shared with third parties.

### 2. Permissions Justification
To perform its core utility, the Extension requires specific browser permissions:
* **`declarativeNetRequest`:** Used natively by the browser to append, edit, or remove custom HTTP headers on outgoing network requests that you specify.
* **`storage`:** Used to save your custom header rules locally so you do not have to re-enter them every time you open the Extension.
* **Host Permissions (`<all_urls>`):** Necessary to allow the Extension to modify headers on any domain or API endpoint you choose to test or debug. 

### 3. Changes to This Policy
We may update this privacy policy from time to time. Any changes will be reflected by updating this document in our repository. Your continued use of the Extension following any updates constitutes your acceptance of the revised policy.

### 4. Contact
If you have any questions or feedback regarding this privacy policy or the Extension, please feel free to open an issue in this repository or contact us at: **[Your Email Address or GitHub Profile Link]**