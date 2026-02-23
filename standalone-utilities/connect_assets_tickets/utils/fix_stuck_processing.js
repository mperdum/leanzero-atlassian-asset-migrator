const TicketConnectionPlanManager = require('./ticketConnectionPlanManager');

const planManager = new TicketConnectionPlanManager();
const plan = planManager.loadOrCreatePlan();

let resetCount = 0;
for (const obj of plan.objects) {
  if (obj.status === "processing") {
    planManager.updateObjectStatus(obj.datacenterKey, "pending", {
      processedTickets: 0,
      successfulTickets: 0,
      failedTickets: 0,
      error: null,
    });
    console.log(`Reset ${obj.datacenterKey} (${obj.ticketCount} tickets)`);
    resetCount++;
  }
}

planManager.savePlan();
console.log(`\n✅ Reset ${resetCount} stuck objects to pending`);
